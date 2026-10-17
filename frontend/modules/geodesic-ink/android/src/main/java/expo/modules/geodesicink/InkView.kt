package expo.modules.geodesicink

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.os.Build
import android.util.Log
import android.view.MotionEvent
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/**
 * Transparent layer over the Skia canvas that draws wet ink natively.
 *
 * Why this is faster than the JavaScript path:
 *  - Samples go straight from Android to this view. No hop to the JS thread,
 *    which is often busy with React work while you write.
 *  - Every sample is used. Android batches the S Pen's extra samples into each
 *    event as "historical" points; the JS gesture library only saw the latest.
 *  - Input is requested unbuffered (Android 11+), so samples arrive as the
 *    digitiser reports them rather than once per frame.
 *  - On Android 10+ the wet stroke is drawn into the buffer that is already on
 *    screen (FrontBufferInk), skipping the frame queue entirely.
 *  - A short prediction is drawn ahead of the nib to hide what latency is
 *    left. It is replaced as real samples arrive and never stored.
 *
 * Only stylus input is handled here. Fingers pass through untouched, so
 * scrolling, zooming and finger drawing keep working exactly as before.
 */
class InkView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {

  private val onStroke by EventDispatcher()

  var tool: String = "pen"
  var baseWidth: Float = 2f
  private var inkEnabled = false
  private var colorInt: Int = Color.BLACK

  // world = (screenDp - t) / scale
  private var scale = 1f
  private var tx = 0f
  private var ty = 0f

  private var pageW = 0f
  private var pageH = 0f
  private var pageStride = 0f
  private var pageCount = 0

  private val density: Float = resources.displayMetrics.density

  private class WetStroke(
    val id: Int,
    val tool: String,
    val color: Int,
    val width: Float, // effective width, world units
    val opacity: Float
  ) {
    val points = ArrayList<InkPt>(256)
    val filter = OneEuro2D()
    var lastRaw: InkPt? = null
    var finished: StrokeDraw? = null
  }

  private var current: WetStroke? = null
  private var activePointerId = -1
  private val pending = ArrayList<WetStroke>()
  private var nextId = 1
  private var prediction: List<InkPt> = emptyList()
  private val tmp = DoubleArray(2)

  private val fillPaint = newFillPaint()
  private val strokePaint = newStrokePaint()

  // Front-buffered rendering (Android 10+). Null when off, unsupported, or it
  // failed to start; drawing then falls back to onDraw below.
  private var wantFrontBuffer = true
  private var front: FrontBufferInk? = null
  /** Pending strokes changed while the pen was down; redraw them at pen-up. */
  private var pendingDirty = false

  init {
    setWillNotDraw(false)
  }

  // ---------------------------------------------------------------- props

  fun setInkEnabled(value: Boolean) {
    inkEnabled = value
    if (!value && current != null) {
      current = null
      activePointerId = -1
      prediction = emptyList()
      front?.cancel()
      invalidate()
    }
  }

  fun setColorHex(hex: String) {
    colorInt = try {
      Color.parseColor(hex)
    } catch (e: IllegalArgumentException) {
      Color.BLACK
    }
  }

  fun setViewTransform(v: List<Double>) {
    if (v.size < 3) return
    scale = v[0].toFloat().let { if (it <= 0f) 1f else it }
    tx = v[1].toFloat()
    ty = v[2].toFloat()
    refreshPending()
    invalidate()
  }

  fun setPages(v: List<Double>) {
    if (v.size < 4) return
    pageW = v[0].toFloat()
    pageH = v[1].toFloat()
    pageStride = v[2].toFloat()
    pageCount = v[3].toInt()
  }

  fun releaseUpTo(id: Int) {
    if (pending.removeAll { it.id <= id }) {
      refreshPending()
      invalidate()
    }
  }

  fun setFrontBuffer(value: Boolean) {
    if (value == wantFrontBuffer) return
    wantFrontBuffer = value
    if (isAttachedToWindow) {
      if (value) startFrontBuffer() else stopFrontBuffer()
    }
  }

  // ------------------------------------------------------------ lifecycle

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    if (wantFrontBuffer) startFrontBuffer()
  }

  override fun onDetachedFromWindow() {
    stopFrontBuffer()
    super.onDetachedFromWindow()
  }

  private fun startFrontBuffer() {
    if (front != null || Build.VERSION.SDK_INT < 29) return
    front = try {
      FrontBufferInk(context, this)
    } catch (t: Throwable) {
      // Any failure here just means the slower path; never a crash.
      Log.w(TAG, "Front-buffered ink unavailable, using normal drawing", t)
      null
    }
    requestLayout()
    invalidate()
  }

  private fun stopFrontBuffer() {
    val f = front ?: return
    front = null
    try {
      f.release()
    } catch (t: Throwable) {
      Log.w(TAG, "Front-buffered ink release failed", t)
    }
    invalidate()
  }

  // React Native lays this view out but not native children; size them here.
  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    val w = r - l
    val h = b - t
    for (i in 0 until childCount) {
      val c = getChildAt(i)
      c.measure(MeasureSpec.makeMeasureSpec(w, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(h, MeasureSpec.EXACTLY))
      c.layout(0, 0, w, h)
    }
  }

  // ---------------------------------------------------------------- input

  private fun worldX(px: Float): Float = (px / density - tx) / scale
  private fun worldY(px: Float): Float = (px / density - ty) / scale

  private fun insidePages(wx: Float, wy: Float): Boolean {
    if (pageCount <= 0 || pageW <= 0f) return false
    if (wx < 0f || wx > pageW || wy < 0f) return false
    val idx = (wy / pageStride).toInt()
    if (idx < 0 || idx >= pageCount) return false
    return wy - idx * pageStride <= pageH
  }

  private fun isStylus(ev: MotionEvent, index: Int): Boolean =
    ev.getToolType(index) == MotionEvent.TOOL_TYPE_STYLUS

  override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
    when (ev.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        val idx = ev.actionIndex
        if (!inkEnabled || !isStylus(ev, idx)) return false
        val wx = worldX(ev.getX(idx))
        val wy = worldY(ev.getY(idx))
        if (!insidePages(wx, wy)) return false
        activePointerId = ev.getPointerId(idx)
        // Take this touch away from the JS gesture handlers (they cancel when a
        // native child asks this), so the pen can't also scroll or draw twice.
        parent?.requestDisallowInterceptTouchEvent(true)
        if (Build.VERSION.SDK_INT >= 30) requestUnbufferedDispatch(ev)
        beginStroke(ev, idx)
        return true
      }
      MotionEvent.ACTION_MOVE -> {
        val s = current ?: return activePointerId != -1
        val idx = ev.findPointerIndex(activePointerId)
        if (idx < 0) return true
        for (h in 0 until ev.historySize) {
          addSample(
            s,
            ev.getHistoricalX(idx, h),
            ev.getHistoricalY(idx, h),
            ev.getHistoricalPressure(idx, h),
            ev.getHistoricalEventTime(h).toDouble()
          )
        }
        addSample(s, ev.getX(idx), ev.getY(idx), ev.getPressure(idx), ev.eventTime.toDouble())
        prediction = predict(s)
        showWet(s)
        return true
      }
      MotionEvent.ACTION_POINTER_UP -> {
        if (ev.getPointerId(ev.actionIndex) == activePointerId) finishStroke(ev, ev.actionIndex)
        return true
      }
      MotionEvent.ACTION_UP -> {
        if (current != null) {
          val idx = ev.findPointerIndex(activePointerId)
          finishStroke(ev, if (idx >= 0) idx else ev.actionIndex)
        }
        activePointerId = -1
        return true
      }
      MotionEvent.ACTION_CANCEL -> {
        current = null
        activePointerId = -1
        prediction = emptyList()
        front?.cancel()
        if (pendingDirty) refreshPending()
        invalidate()
        return true
      }
      else -> return activePointerId != -1
    }
  }

  private fun beginStroke(ev: MotionEvent, idx: Int) {
    val effective = InkGeometry.effectiveWidth(tool, baseWidth)
    val s = WetStroke(nextId++, tool, colorInt, effective, InkGeometry.opacity(tool))
    current = s
    prediction = emptyList()
    s.filter.reset()
    val t = ev.eventTime.toDouble()
    val wx = worldX(ev.getX(idx)).toDouble()
    val wy = worldY(ev.getY(idx)).toDouble()
    s.filter.filter(wx, wy, t, tmp)
    val p = ev.getPressure(idx).coerceIn(0f, 1f)
    s.points.add(InkPt(tmp[0].toFloat(), tmp[1].toFloat(), t, p))
    InkGeometry.annotateWidth(s.points, 0, InkGeometry.profile(s.tool))
    s.lastRaw = InkPt(wx.toFloat(), wy.toFloat(), t, p)
    showWet(s)
  }

  /** Same gate as the JS path: filtered position, 0.25 world-unit minimum step. */
  private fun addSample(s: WetStroke, px: Float, pyPx: Float, pressure: Float, t: Double) {
    val wx = worldX(px).toDouble()
    val wy = worldY(pyPx).toDouble()
    val p = pressure.coerceIn(0f, 1f)
    s.lastRaw = InkPt(wx.toFloat(), wy.toFloat(), t, p)
    val last = s.points[s.points.size - 1]
    // Historical samples can repeat the previous timestamp; keep time monotonic.
    val tt = max(t, last.t + 0.01)
    s.filter.filter(wx, wy, tt, tmp)
    val fx = tmp[0].toFloat()
    val fy = tmp[1].toFloat()
    if (hypot(fx - last.x, fy - last.y) < MIN_SAMPLE_DISTANCE) return
    s.points.add(InkPt(fx, fy, tt, p))
    InkGeometry.annotateWidth(s.points, s.points.size - 1, InkGeometry.profile(s.tool))
  }

  private fun finishStroke(ev: MotionEvent, idx: Int) {
    val s = current ?: return
    if (idx >= 0 && idx < ev.pointerCount) {
      addSample(s, ev.getX(idx), ev.getY(idx), ev.getPressure(idx), ev.eventTime.toDouble())
    }
    // The filter trails the pen slightly; end the line where the pen lifted.
    val raw = s.lastRaw
    val last = s.points[s.points.size - 1]
    if (raw != null && hypot(raw.x - last.x, raw.y - last.y) > MIN_SAMPLE_DISTANCE) {
      s.points.add(InkPt(raw.x, raw.y, max(raw.t, last.t + 0.5), raw.p))
      InkGeometry.annotateWidth(s.points, s.points.size - 1, InkGeometry.profile(s.tool))
    }
    current = null
    activePointerId = -1
    prediction = emptyList()

    // Keep drawing it (finished, with its exit taper, exactly as JS will) until
    // JavaScript reports it has drawn it, so there's no blank frame in between.
    s.finished = drawFor(s, s.points, true)
    pending.add(s)
    pendingDirty = false
    val f = front
    if (f != null) f.commit(pendingDraws(), transform()) else invalidate()

    val flat = ArrayList<Double>(s.points.size * 5)
    for (pt in s.points) {
      flat.add(pt.x.toDouble())
      flat.add(pt.y.toDouble())
      flat.add(pt.t)
      flat.add(pt.p.toDouble())
      flat.add(pt.w.toDouble())
    }
    onStroke(mapOf("id" to s.id, "tool" to s.tool, "points" to flat))
  }

  /**
   * Linear prediction ~one frame ahead from the recent velocity. Short and
   * capped: overshooting a sharp turn looks worse than a little lag.
   */
  private fun predict(s: WetStroke): List<InkPt> {
    val pts = s.points
    val n = pts.size
    if (n < 3) return emptyList()
    val last = pts[n - 1]
    var j = n - 2
    while (j > 0 && last.t - pts[j].t < PREDICT_WINDOW_MS) j--
    val ref = pts[j]
    val dt = (last.t - ref.t).toFloat()
    if (dt <= 0f) return emptyList()
    val vx = (last.x - ref.x) / dt
    val vy = (last.y - ref.y) / dt
    val speed = hypot(vx, vy)
    if (speed < 0.05f) return emptyList()
    val ahead = min(speed * PREDICT_AHEAD_MS, s.width * 4f)
    val ux = vx / speed
    val uy = vy / speed
    val mid = InkPt(last.x + ux * ahead * 0.5f, last.y + uy * ahead * 0.5f, last.t + PREDICT_AHEAD_MS / 2.0, last.p, last.w)
    val end = InkPt(last.x + ux * ahead, last.y + uy * ahead, last.t + PREDICT_AHEAD_MS.toDouble(), last.p, last.w)
    return listOf(mid, end)
  }

  // ---------------------------------------------------------------- drawing

  private fun transform(): InkTransform {
    val clipH = if (pageCount > 0) (pageCount - 1) * pageStride + pageH else 0f
    return InkTransform(scale * density, tx * density, ty * density, pageW, clipH)
  }

  private fun drawFor(s: WetStroke, pts: List<InkPt>, finished: Boolean): StrokeDraw {
    val alpha = (s.opacity * 255f).toInt().coerceIn(0, 255)
    val stroked = InkGeometry.profile(s.tool).constantWidth && pts.size > 1
    return StrokeDraw(InkGeometry.buildPath(pts, s.width, s.tool, finished), s.color, alpha, stroked, s.width)
  }

  private fun pendingDraws(): List<StrokeDraw> = pending.mapNotNull { it.finished }

  private fun showWet(s: WetStroke) {
    val f = front
    if (f == null) {
      invalidate()
      return
    }
    val pts: List<InkPt> = if (prediction.isEmpty()) s.points else s.points + prediction
    f.renderWet(drawFor(s, pts, false), transform())
  }

  /**
   * Redraw the finished-but-not-yet-handed-over strokes. With front buffering,
   * re-rendering that layer while the pen is down would hide the wet stroke
   * for a frame, so it waits until pen-up (commit draws them then anyway).
   */
  private fun refreshPending() {
    val f = front ?: return
    if (current != null) {
      pendingDirty = true
      return
    }
    pendingDirty = false
    f.showPending(pendingDraws(), transform())
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    if (front != null) return // the front-buffer layer draws everything
    val s = current
    if (pending.isEmpty() && s == null) return
    canvas.save()
    transform().apply(canvas)
    for (p in pending) p.finished?.draw(canvas, fillPaint, strokePaint)
    if (s != null && s.points.isNotEmpty()) {
      val pts: List<InkPt> = if (prediction.isEmpty()) s.points else s.points + prediction
      drawFor(s, pts, false).draw(canvas, fillPaint, strokePaint)
    }
    canvas.restore()
  }

  companion object {
    private const val TAG = "GeodesicInk"
    private const val MIN_SAMPLE_DISTANCE = 0.25f
    private const val PREDICT_WINDOW_MS = 24.0
    private const val PREDICT_AHEAD_MS = 14f
  }
}
