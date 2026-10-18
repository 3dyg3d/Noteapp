package expo.modules.geodesicink

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Picture
import android.graphics.RectF
import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.lang.ref.WeakReference
import java.util.concurrent.Executors
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** A stored stroke, ready to draw. Built once; immutable. */
class DryStroke(@JvmField val id: Int, @JvmField val draw: StrokeDraw, @JvmField val bounds: RectF)

/**
 * The note's stored ink, drawn natively with the same geometry and the same
 * renderer as the wet ink in [InkView].
 *
 * Previously the wet stroke (drawn here by Android) was swapped for a copy
 * drawn by Skia once JavaScript had stored it. Two renderers never produce
 * exactly the same pixels, and the swap couldn't be timed to the frame, so
 * the stroke visibly shifted just after the pen lifted. Now the finished
 * stroke moves from [InkView] into this view in the same frame, and it's the
 * same path drawn by the same canvas: nothing changes.
 *
 * Strokes arrive two ways:
 *  - from [InkView] at pen-up ("provisional": JavaScript hasn't stored it yet);
 *  - from JavaScript via [sync]: the full drawing order, plus point data for
 *    strokes this view doesn't hold yet (a loaded note, undo, an edited stroke).
 *
 * Drawing is cached per page as a [Picture], re-recorded only when that
 * page's strokes change; panning and zooming just replay the pictures.
 */
class DryInkView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {

  private val onReady by EventDispatcher()

  private val density: Float = resources.displayMetrics.density
  private var scale = 1f
  private var tx = 0f
  private var ty = 0f
  private var pageW = 0f
  private var pageH = 0f
  private var pageStride = 0f
  private var pageCount = 0

  private val strokes = HashMap<Int, DryStroke>()
  /** Drawing order from JavaScript. */
  private var order = IntArray(0)
  private var orderSet = HashSet<Int>()
  /** From the pen, not in JavaScript's order yet. Drawn after it. */
  private val provisional = LinkedHashSet<Int>()
  private var hidden = HashSet<Int>()

  /** Recorded pages; a missing entry is re-recorded on the next draw. */
  private val pictures = HashMap<Int, Picture>()

  private val fill = newFillPaint()
  private val stroke = newStrokePaint()

  var group: String = ""
    set(value) {
      if (value == field) return
      unregister()
      field = value
      register()
      // Named after attaching: ask for everything again under this name.
      if (isAttachedToWindow) onReady(mapOf("group" to value))
    }

  init {
    setWillNotDraw(false)
  }

  // ---------------------------------------------------------------- props

  fun setViewTransform(v: List<Double>) {
    if (v.size < 3) return
    val ns = v[0].toFloat().let { if (it <= 0f) 1f else it }
    val nx = v[1].toFloat()
    val ny = v[2].toFloat()
    if (ns == scale && nx == tx && ny == ty) return
    scale = ns
    tx = nx
    ty = ny
    invalidate()
  }

  fun setPages(v: List<Double>) {
    if (v.size < 4) return
    val w = v[0].toFloat()
    val h = v[1].toFloat()
    val st = v[2].toFloat()
    val c = v[3].toInt()
    if (w == pageW && h == pageH && st == pageStride && c == pageCount) return
    val geometryChanged = w != pageW || st != pageStride
    pageW = w
    pageH = h
    pageStride = st
    pageCount = c
    if (geometryChanged) pictures.clear()
    invalidate()
  }

  // ------------------------------------------------------------ lifecycle

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    register()
    // JavaScript resends everything: this view starts out empty.
    onReady(mapOf("group" to group))
  }

  override fun onDetachedFromWindow() {
    unregister()
    super.onDetachedFromWindow()
  }

  private fun register() {
    if (group.isNotEmpty() && isAttachedToWindow) registry[group] = WeakReference(this)
  }

  private fun unregister() {
    if (registry[group]?.get() === this) registry.remove(group)
  }

  // ------------------------------------------------------------- updates

  /** The pen just finished this stroke. UI thread. */
  fun addProvisional(s: DryStroke) {
    strokes[s.id] = s
    if (!orderSet.contains(s.id)) provisional.add(s.id)
    dirty(s.bounds)
    invalidate()
  }

  /** Apply a sync from JavaScript. UI thread. */
  internal fun apply(u: SyncUpdate) {
    for (s in u.adds) {
      val old = strokes.put(s.id, s)
      if (old != null) dirty(old.bounds)
      dirty(s.bounds)
    }
    for (id in u.drops) {
      if (provisional.remove(id)) strokes.remove(id)?.let { dirty(it.bounds) }
    }
    val newSet = HashSet<Int>(u.order.size * 2)
    for (id in u.order) newSet.add(id)
    // Gone from the note.
    for (id in order) {
      if (!newSet.contains(id)) strokes.remove(id)?.let { dirty(it.bounds) }
    }
    // Adopted: the pen's stroke is now in the note.
    provisional.removeAll(newSet)
    // Anything that moved relative to the rest means a full re-record.
    if (!sameRelativeOrder(order, u.order, orderSet, newSet)) pictures.clear()
    order = u.order
    orderSet = newSet
    if (u.hidden != hidden) {
      for (id in u.hidden) if (!hidden.contains(id)) strokes[id]?.let { dirty(it.bounds) }
      for (id in hidden) if (!u.hidden.contains(id)) strokes[id]?.let { dirty(it.bounds) }
      hidden = u.hidden
    }
    invalidate()
  }

  /** Do the strokes kept by both orders appear in the same sequence? */
  private fun sameRelativeOrder(a: IntArray, b: IntArray, aSet: Set<Int>, bSet: Set<Int>): Boolean {
    var i = 0
    var j = 0
    while (true) {
      while (i < a.size && !bSet.contains(a[i])) i++
      while (j < b.size && !aSet.contains(b[j])) j++
      if (i >= a.size || j >= b.size) return i >= a.size && j >= b.size
      if (a[i] != b[j]) return false
      i++
      j++
    }
  }

  private fun bandOf(y: Float): Int = if (pageStride <= 0f) 0 else floor(y / pageStride).toInt()

  private fun dirty(r: RectF) {
    if (pageStride <= 0f) {
      pictures.clear()
      return
    }
    for (b in max(0, bandOf(r.top))..min(max(0, pageCount - 1), bandOf(r.bottom))) pictures.remove(b)
  }

  // ---------------------------------------------------------------- drawing

  private fun record(band: Int): Picture {
    val pic = Picture()
    val top = band * pageStride
    val w = max(1, pageW.roundToInt())
    val h = max(1, pageStride.roundToInt())
    val c = pic.beginRecording(w, h)
    c.translate(0f, -top)
    val bottom = top + pageStride
    fun drawIf(id: Int) {
      if (hidden.contains(id)) return
      val s = strokes[id] ?: return
      if (s.bounds.bottom < top || s.bounds.top > bottom) return
      s.draw.draw(c, fill, stroke)
    }
    for (id in order) drawIf(id)
    for (id in provisional) drawIf(id)
    pic.endRecording()
    return pic
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    if (pageCount <= 0 || pageStride <= 0f || (strokes.isEmpty())) return
    val s = scale * density
    canvas.save()
    canvas.translate(tx * density, ty * density)
    canvas.scale(s, s)
    // Visible world rows.
    val y0 = -ty / scale
    val y1 = (height / density - ty) / scale
    val first = max(0, bandOf(y0))
    val last = min(pageCount - 1, bandOf(y1))
    for (b in first..last) {
      val pic = pictures[b] ?: record(b).also { pictures[b] = it }
      val top = b * pageStride
      canvas.save()
      // Each page shows only its own band, so a stroke recorded on two
      // pages is never drawn twice in the same place.
      canvas.clipRect(0f, top, pageW, top + pageStride)
      canvas.translate(0f, top)
      canvas.drawPicture(pic)
      canvas.restore()
    }
    canvas.restore()
  }

  companion object {
    private val registry = HashMap<String, WeakReference<DryInkView>>()
    private val worker = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())

    fun find(group: String): DryInkView? = if (group.isEmpty()) null else registry[group]?.get()

    /** Build a stroke from stored data; same rules as the exporter. Any thread. */
    fun build(id: Int, tool: String, color: Int, width: Float, shape: Boolean, data: FloatArray, from: Int, n: Int): DryStroke? {
      if (n <= 0) return null
      val pts = ArrayList<InkPt>(n)
      var missingW = false
      for (k in 0 until n) {
        val o = from + k * STRIDE
        var w = data[o + 4]
        if (w.isNaN() || w <= 0f) { missingW = true; w = 1f }
        pts.add(InkPt(data[o], data[o + 1], data[o + 2].toDouble(), data[o + 3], w, data[o + 5]))
      }
      if (missingW) for (k in pts.indices) InkGeometry.annotateWidth(pts, k, InkGeometry.profile(tool))
      val eff = InkGeometry.effectiveWidth(tool, width)
      return fromPoints(id, tool, color, eff, shape, pts)
    }

    /** `width` is the effective width (as [InkView] keeps it). */
    fun fromPoints(id: Int, tool: String, color: Int, width: Float, shape: Boolean, pts: List<InkPt>): DryStroke {
      val path = InkGeometry.buildPath(pts, width, tool, true, shape)
      val alpha = min((InkGeometry.opacity(tool) * 255f).roundToInt(), Color.alpha(color))
      val stroked = InkGeometry.profile(tool).constantWidth && pts.size > 1
      val shader = if (tool == "pencil") InkGrain.shader(color) else null
      return fromDraw(id, StrokeDraw(path, color, alpha, stroked, width, shader))
    }

    fun fromDraw(id: Int, d: StrokeDraw): DryStroke {
      val r = RectF()
      d.path.computeBounds(r, true)
      val pad = if (d.stroked) d.width / 2f + 1f else 1f
      r.inset(-pad, -pad)
      return DryStroke(id, d, r)
    }

    /**
     * From JavaScript (its thread). `meta` is JSON:
     * {order:[id...], hidden:[id...], drops:[id...], adds:[{id, tool, color, width, shape?, n}]}
     * and `data` holds the added strokes' points back to back, STRIDE floats each.
     * Paths are built off the UI thread; updates are applied in arrival order.
     */
    fun sync(group: String, meta: String, data: FloatArray) {
      worker.execute {
        val u = try {
          parse(meta, data)
        } catch (t: Throwable) {
          android.util.Log.w("GeodesicInk", "dry sync failed", t)
          null
        } ?: return@execute
        main.post { find(group)?.apply(u) }
      }
    }

    private fun ints(a: org.json.JSONArray?): IntArray {
      if (a == null) return IntArray(0)
      return IntArray(a.length()) { a.getInt(it) }
    }

    private fun parse(meta: String, data: FloatArray): SyncUpdate {
      val j = org.json.JSONObject(meta)
      val order = ints(j.optJSONArray("order"))
      val hidden = HashSet<Int>().apply { for (id in ints(j.optJSONArray("hidden"))) add(id) }
      val drops = ints(j.optJSONArray("drops"))
      val addsJ = j.optJSONArray("adds")
      val adds = ArrayList<DryStroke>()
      var off = 0
      if (addsJ != null) {
        for (k in 0 until addsJ.length()) {
          val a = addsJ.getJSONObject(k)
          val n = a.optInt("n", 0)
          if (off + n * STRIDE > data.size) break
          val color = try { Color.parseColor(a.optString("color", "#000000")) } catch (e: Exception) { Color.BLACK }
          build(
            a.getInt("id"), a.optString("tool", "pen"), color, a.optDouble("width", 2.0).toFloat(),
            a.optBoolean("shape", false), data, off, n
          )?.let { adds.add(it) }
          off += n * STRIDE
        }
      }
      return SyncUpdate(order, hidden, drops, adds)
    }

    const val STRIDE = 6
  }
}

internal class SyncUpdate(
  @JvmField val order: IntArray,
  @JvmField val hidden: HashSet<Int>,
  @JvmField val drops: IntArray,
  @JvmField val adds: List<DryStroke>
)
