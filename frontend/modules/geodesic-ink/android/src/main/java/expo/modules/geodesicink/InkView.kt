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
  private val onErase by EventDispatcher()
  private val onPenButton by EventDispatcher()
  private val onSelect by EventDispatcher()

  /**
   * What a stylus touch does: "ink" (pen tools), "erase" (eraser tool),
   * "lasso" / "rect" (selection), or "none" (left to JavaScript).
   */
  var mode: String = "ink"
  private var accentInt: Int = Color.rgb(123, 140, 115)

  fun setAccentHex(hex: String) {
    accentInt = try { Color.parseColor(hex) } catch (e: IllegalArgumentException) { accentInt }
  }

  // Selection outline being drawn, in view px.
  private var selecting = false
  private var selKind = "lasso"
  private val selPx = ArrayList<Float>(256)
  private val selPaint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
    style = android.graphics.Paint.Style.STROKE
    strokeJoin = android.graphics.Paint.Join.ROUND
    strokeCap = android.graphics.Paint.Cap.ROUND
  }
  private val selFill = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
    style = android.graphics.Paint.Style.FILL
  }

  /** What the S Pen side button does: "none", "eraser", "undo" or "redo". */
  var buttonAction: String = "eraser"
  /** Hover cursor diameter in world units; 0 hides it. */
  var cursorWidth: Float = 0f
  /** Eraser diameter in world units, for the cursor while button-erasing. */
  var eraserWidth: Float = 24f

  // Hover cursor (pen near the screen, not touching), in view pixels.
  private var hovering = false
  private var hoverX = 0f
  private var hoverY = 0f
  private var hoverButton = false
  // Erasing with the side button held: the pen position, in view pixels.
  private var erasing = false
  private var eraseX = 0f
  private var eraseY = 0f
  /** The current touch is being swallowed (button click mapped to undo/redo). */
  private var swallowing = false
  private val cursorPaint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
    style = android.graphics.Paint.Style.STROKE
  }

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
    /** Arc length so far, world units. */
    var length = 0f
    /** Front buffer: drawing only new pieces now (vs. redrawing everything). */
    var incremental = false
    /** Segments below this index are drawn exactly on the front buffer. */
    var drawnTo = 0
    /** Fold patches already drawn. */
    val patched = HashSet<Int>()
    /** Set once the stroke has been snapped to a shape ("circle", "rectangle", ...). */
    var shape: String? = null
    /** Drawn on the front buffer (opaque ink) rather than in onDraw. */
    var onFront = false
  }

  // ------------------------------------------------------------ shape snap

  /** Hold the pen still at the end of a stroke to turn it into a clean shape. */
  var shapeSnap: Boolean = true
  private val holdHandler = android.os.Handler(android.os.Looper.getMainLooper())
  private var holdX = 0f
  private var holdY = 0f
  private val holdRunnable = Runnable { trySnap() }

  /** Restart the hold timer whenever the pen has moved more than a few dp. */
  private fun trackHold(px: Float, py: Float, force: Boolean) {
    if (!shapeSnap) return
    if (force || hypot(px - holdX, py - holdY) > HOLD_SLOP_DP * density) {
      holdX = px
      holdY = py
      holdHandler.removeCallbacks(holdRunnable)
      holdHandler.postDelayed(holdRunnable, HOLD_MS)
    }
  }

  private fun cancelHold() {
    holdHandler.removeCallbacks(holdRunnable)
  }

  private fun trySnap() {
    val s = current ?: return
    if (s.shape != null || s.points.size < 8) return
    val n = s.points.size
    val xs = FloatArray(n) { s.points[it].x }
    val ys = FloatArray(n) { s.points[it].y }
    val shape = ShapeRecognizer.recognize(xs, ys) ?: return
    // Even width from the median of what was drawn; pressure likewise.
    val ws = s.points.map { it.w }.sorted()
    val ps = s.points.map { it.p }.sorted()
    val w = ws[ws.size / 2]
    val p = ps[ps.size / 2]
    val t0 = s.points[0].t
    s.points.clear()
    for (i in shape.xs.indices) s.points.add(InkPt(shape.xs[i], shape.ys[i], t0 + i * 4.0, p, w, 0f))
    s.shape = shape.kind
    s.incremental = false
    prediction = emptyList()
    performHapticFeedback(android.view.HapticFeedbackConstants.LONG_PRESS)
    showWet(s)
  }

  private var current: WetStroke? = null
  private var activePointerId = -1
  private val pending = ArrayList<WetStroke>()
  /** Group of the [DryInkView] that takes finished strokes; empty = none. */
  var dryGroup: String = ""
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
      front?.show(pendingDraws(), transform())
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
    val ns = v[0].toFloat().let { if (it <= 0f) 1f else it }
    val nx = v[1].toFloat()
    val ny = v[2].toFloat()
    // JS sends a new array on every render; only a real move needs a redraw.
    if (ns == scale && nx == tx && ny == ty) return
    scale = ns
    tx = nx
    ty = ny
    if (pending.isNotEmpty()) refreshPending()
    invalidate()
  }

  fun setPages(v: List<Double>) {
    if (v.size < 4) return
    pageW = v[0].toFloat()
    pageH = v[1].toFloat()
    pageStride = v[2].toFloat()
    pageCount = v[3].toInt()
  }

  /**
   * JavaScript has drawn strokes up to `id`. Its frame reaches the screen on
   * the next vsync, so the copies here go on that same frame: earlier leaves
   * a blank frame, later shows both copies at once.
   */
  fun releaseUpTo(id: Int) {
    if (id <= releaseId) return
    releaseId = id
    if (releasePosted) return
    releasePosted = true
    android.view.Choreographer.getInstance().postFrameCallback {
      releasePosted = false
      if (pending.removeAll { it.id <= releaseId }) {
        refreshPending()
        invalidate()
      }
    }
  }
  private var releaseId = 0
  private var releasePosted = false

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
    cancelHold()
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

  // ----------------------------------------------------------------- ruler
  // Port of rulerProject / rulerContains / rulerEdgeSign in src/components/Ruler.tsx.
  // All in screen dp, the ruler component's own coordinate space.

  private var rulerOn = false
  private var rulerX = 0f
  private var rulerY = 0f
  private var rulerDx = 1f
  private var rulerDy = 0f
  private var rulerHalf = 77.5f
  /** The current stroke is locked to a ruler edge: +1 bottom, -1 top, 0 free. */
  private var rulerEdge = 0
  private val snapped = FloatArray(2)

  /** [enabled, centreX, centreY, angleDegrees, halfThickness] in dp. */
  fun setRuler(v: List<Double>) {
    if (v.size < 5) return
    rulerOn = v[0] > 0.5
    rulerX = v[1].toFloat()
    rulerY = v[2].toFloat()
    val rad = Math.toRadians(v[3])
    rulerDx = Math.cos(rad).toFloat()
    rulerDy = Math.sin(rad).toFloat()
    rulerHalf = v[4].toFloat()
  }

  /** Signed distance from the ruler's centre line (positive = bottom side). */
  private fun rulerPerp(xDp: Float, yDp: Float): Float =
    (xDp - rulerX) * -rulerDy + (yDp - rulerY) * rulerDx

  /** Project onto the edge on side `edge`; result in snapped[0..1] (dp). */
  private fun rulerProjectTo(xDp: Float, yDp: Float, edge: Int) {
    val t = (xDp - rulerX) * rulerDx + (yDp - rulerY) * rulerDy
    val off = edge * rulerHalf
    snapped[0] = rulerX + t * rulerDx + off * -rulerDy
    snapped[1] = rulerY + t * rulerDy + off * rulerDx
  }

  /**
   * Same rules as the JS path: a stroke that starts within 40 dp of an edge
   * locks to it; one that runs into the ruler's body (6 dp tolerance) locks to
   * the side it came from. Once locked, every sample is projected onto that
   * edge, so the line is perfectly straight.
   */
  private fun rulerStart(xDp: Float, yDp: Float) {
    rulerEdge = 0
    if (!rulerOn) return
    val perp = rulerPerp(xDp, yDp)
    val edge = if (perp >= 0f) 1 else -1
    rulerProjectTo(xDp, yDp, edge)
    if (hypot(xDp - snapped[0], yDp - snapped[1]) <= 40f) rulerEdge = edge
  }

  /** Map a pen position (view px) to world units, applying the ruler. */
  private fun mapPen(px: Float, py: Float, out: FloatArray) {
    var xDp = px / density
    var yDp = py / density
    if (rulerOn) {
      if (rulerEdge == 0) {
        val perp = rulerPerp(xDp, yDp)
        if (kotlin.math.abs(perp) <= rulerHalf + 6f) rulerEdge = if (perp >= 0f) 1 else -1
      }
      if (rulerEdge != 0) {
        rulerProjectTo(xDp, yDp, rulerEdge)
        xDp = snapped[0]
        yDp = snapped[1]
      }
    }
    out[0] = (xDp - tx) / scale
    out[1] = (yDp - ty) / scale
  }

  private val mapped = FloatArray(2)

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
        if (!isStylus(ev, idx)) return false
        if (mode == "erase" || mode == "lasso" || mode == "rect") {
          activePointerId = ev.getPointerId(idx)
          parent?.requestDisallowInterceptTouchEvent(true)
          if (Build.VERSION.SDK_INT >= 30) requestUnbufferedDispatch(ev)
          hovering = false
          if (mode == "erase") beginErase(ev, idx) else beginSelect(ev, idx)
          return true
        }
        if (mode != "ink" || !inkEnabled) return false
        val wx = worldX(ev.getX(idx))
        val wy = worldY(ev.getY(idx))
        if (!insidePages(wx, wy)) return false
        activePointerId = ev.getPointerId(idx)
        // Take this touch away from the JS gesture handlers (they cancel when a
        // native child asks this), so the pen can't also scroll or draw twice.
        parent?.requestDisallowInterceptTouchEvent(true)
        if (Build.VERSION.SDK_INT >= 30) requestUnbufferedDispatch(ev)
        val button = (ev.buttonState and MotionEvent.BUTTON_STYLUS_PRIMARY) != 0
        if (button && buttonAction == "eraser") {
          beginErase(ev, idx)
        } else if (button && (buttonAction == "undo" || buttonAction == "redo")) {
          // Button held as the pen lands: run the action once, draw nothing.
          swallowing = true
          onPenButton(mapOf("action" to buttonAction))
        } else {
          beginStroke(ev, idx)
        }
        hovering = false
        return true
      }
      MotionEvent.ACTION_MOVE -> {
        if (erasing) {
          moveErase(ev)
          return true
        }
        if (selecting) {
          moveSelect(ev)
          return true
        }
        if (swallowing) return true
        val s = current ?: return activePointerId != -1
        val idx = ev.findPointerIndex(activePointerId)
        if (idx < 0) return true
        for (h in 0 until ev.historySize) {
          addSample(
            s,
            ev.getHistoricalX(idx, h),
            ev.getHistoricalY(idx, h),
            ev.getHistoricalPressure(idx, h),
            ev.getHistoricalEventTime(h).toDouble(),
            ev.getHistoricalAxisValue(MotionEvent.AXIS_TILT, idx, h)
          )
        }
        addSample(s, ev.getX(idx), ev.getY(idx), ev.getPressure(idx), ev.eventTime.toDouble(), ev.getAxisValue(MotionEvent.AXIS_TILT, idx))
        if (s.shape != null) return true
        trackHold(ev.getX(idx), ev.getY(idx), false)
        prediction = predict(s)
        showWet(s)
        return true
      }
      MotionEvent.ACTION_POINTER_UP -> {
        if (ev.getPointerId(ev.actionIndex) == activePointerId) finishStroke(ev, ev.actionIndex)
        return true
      }
      MotionEvent.ACTION_UP -> {
        if (selecting) {
          endSelect(true)
          activePointerId = -1
          return true
        }
        if (erasing || swallowing) {
          endErase()
          activePointerId = -1
          return true
        }
        if (current != null) {
          val idx = ev.findPointerIndex(activePointerId)
          finishStroke(ev, if (idx >= 0) idx else ev.actionIndex)
        }
        activePointerId = -1
        return true
      }
      MotionEvent.ACTION_CANCEL -> {
        cancelHold()
        endErase()
        endSelect(false)
        current = null
        activePointerId = -1
        prediction = emptyList()
        refreshPending() // drops the wet stroke, keeps strokes still waiting
        invalidate()
        return true
      }
      else -> return activePointerId != -1
    }
  }

  // ---------------------------------------------------------------- erasing

  private fun beginErase(ev: MotionEvent, idx: Int) {
    erasing = true
    eraseX = ev.getX(idx)
    eraseY = ev.getY(idx)
    onErase(mapOf("points" to arrayListOf(worldX(eraseX).toDouble(), worldY(eraseY).toDouble()), "start" to true))
    invalidate()
  }

  private fun moveErase(ev: MotionEvent) {
    val idx = ev.findPointerIndex(activePointerId)
    if (idx < 0) return
    val pts = ArrayList<Double>((ev.historySize + 1) * 2)
    for (h in 0 until ev.historySize) {
      pts.add(worldX(ev.getHistoricalX(idx, h)).toDouble())
      pts.add(worldY(ev.getHistoricalY(idx, h)).toDouble())
    }
    eraseX = ev.getX(idx)
    eraseY = ev.getY(idx)
    pts.add(worldX(eraseX).toDouble())
    pts.add(worldY(eraseY).toDouble())
    onErase(mapOf("points" to pts, "start" to false))
    invalidate()
  }

  private fun endErase() {
    if (erasing) invalidate()
    erasing = false
    swallowing = false
  }

  // ------------------------------------------------------------- selection

  private fun beginSelect(ev: MotionEvent, idx: Int) {
    selecting = true
    selKind = mode
    selPx.clear()
    selPx.add(ev.getX(idx))
    selPx.add(ev.getY(idx))
    invalidate()
  }

  private fun moveSelect(ev: MotionEvent) {
    val idx = ev.findPointerIndex(activePointerId)
    if (idx < 0) return
    if (selKind == "rect") {
      // Only the far corner matters.
      while (selPx.size > 2) selPx.removeAt(selPx.size - 1)
      selPx.add(ev.getX(idx))
      selPx.add(ev.getY(idx))
    } else {
      for (h in 0 until ev.historySize) {
        selPx.add(ev.getHistoricalX(idx, h))
        selPx.add(ev.getHistoricalY(idx, h))
      }
      selPx.add(ev.getX(idx))
      selPx.add(ev.getY(idx))
    }
    invalidate()
  }

  /** Pen lifted: hand the outline (world units) to JavaScript, which picks the items. */
  private fun endSelect(emit: Boolean) {
    if (!selecting) return
    selecting = false
    if (emit && selPx.size >= 4) {
      val world = ArrayList<Double>(selPx.size)
      var i = 0
      while (i + 1 < selPx.size) {
        world.add(worldX(selPx[i]).toDouble())
        world.add(worldY(selPx[i + 1]).toDouble())
        i += 2
      }
      onSelect(mapOf("kind" to selKind, "points" to world))
    }
    selPx.clear()
    invalidate()
  }

  private fun drawSelection(canvas: Canvas) {
    if (!selecting || selPx.size < 4) return
    val path = android.graphics.Path()
    if (selKind == "rect") {
      val l = min(selPx[0], selPx[2]); val r = max(selPx[0], selPx[2])
      val t = min(selPx[1], selPx[3]); val b = max(selPx[1], selPx[3])
      path.addRect(l, t, r, b, android.graphics.Path.Direction.CW)
    } else {
      path.moveTo(selPx[0], selPx[1])
      var i = 2
      while (i + 1 < selPx.size) {
        path.lineTo(selPx[i], selPx[i + 1])
        i += 2
      }
    }
    selFill.color = Color.argb(28, Color.red(accentInt), Color.green(accentInt), Color.blue(accentInt))
    canvas.drawPath(path, selFill)
    selPaint.color = accentInt
    selPaint.strokeWidth = 1.6f * density
    selPaint.pathEffect = android.graphics.DashPathEffect(floatArrayOf(7f * density, 5f * density), 0f)
    canvas.drawPath(path, selPaint)
  }

  // ----------------------------------------------------------------- hover

  /**
   * Pen hovering above the screen: show where the nib will land, and treat a
   * side-button click as undo/redo when the button is set to one of those.
   */
  override fun dispatchHoverEvent(ev: MotionEvent): Boolean {
    if (ev.getToolType(0) != MotionEvent.TOOL_TYPE_STYLUS) return false
    when (ev.actionMasked) {
      MotionEvent.ACTION_HOVER_ENTER, MotionEvent.ACTION_HOVER_MOVE -> {
        hovering = true
        hoverX = ev.x
        hoverY = ev.y
        val pressed = (ev.buttonState and MotionEvent.BUTTON_STYLUS_PRIMARY) != 0
        if (pressed && !hoverButton && (buttonAction == "undo" || buttonAction == "redo")) {
          onPenButton(mapOf("action" to buttonAction))
        }
        hoverButton = pressed
        invalidate()
      }
      MotionEvent.ACTION_HOVER_EXIT -> {
        hovering = false
        hoverButton = false
        invalidate()
      }
    }
    return true
  }

  private fun drawCursor(canvas: Canvas) {
    val x: Float
    val y: Float
    val worldDiameter: Float
    if (erasing) {
      x = eraseX; y = eraseY; worldDiameter = eraserWidth
    } else if (hovering && cursorWidth > 0f) {
      x = hoverX; y = hoverY
      worldDiameter = if (hoverButton && buttonAction == "eraser") eraserWidth else cursorWidth
    } else {
      return
    }
    val r = max(3f * density, worldDiameter / 2f * scale * density)
    // Light halo under a dark ring: visible on white, black and coloured paper.
    cursorPaint.strokeWidth = 3f * density
    cursorPaint.color = Color.argb(150, 255, 255, 255)
    canvas.drawCircle(x, y, r, cursorPaint)
    cursorPaint.strokeWidth = 1.2f * density
    cursorPaint.color = Color.argb(200, 40, 40, 44)
    canvas.drawCircle(x, y, r, cursorPaint)
  }

  private fun beginStroke(ev: MotionEvent, idx: Int) {
    val effective = InkGeometry.effectiveWidth(tool, baseWidth)
    val s = WetStroke(STROKE_IDS.getAndIncrement(), tool, colorInt, effective, InkGeometry.opacity(tool))
    current = s
    prediction = emptyList()
    s.filter.reset()
    val t = ev.eventTime.toDouble()
    rulerStart(ev.getX(idx) / density, ev.getY(idx) / density)
    mapPen(ev.getX(idx), ev.getY(idx), mapped)
    val wx = mapped[0].toDouble()
    val wy = mapped[1].toDouble()
    s.filter.filter(wx, wy, t, tmp)
    val p = ev.getPressure(idx).coerceIn(0f, 1f)
    val tilt = ev.getAxisValue(MotionEvent.AXIS_TILT, idx)
    s.points.add(InkPt(tmp[0].toFloat(), tmp[1].toFloat(), t, p, 1f, tilt))
    InkGeometry.annotateWidth(s.points, 0, InkGeometry.profile(s.tool))
    s.lastRaw = InkPt(wx.toFloat(), wy.toFloat(), t, p, 1f, tilt)
    trackHold(ev.getX(idx), ev.getY(idx), true)
    showWet(s)
  }

  /** Same gate as the JS path: filtered position, 0.25 world-unit minimum step. */
  private fun addSample(s: WetStroke, px: Float, pyPx: Float, pressure: Float, t: Double, tilt: Float = 0f) {
    if (s.shape != null) return // snapped: the shape stays put until the pen lifts
    mapPen(px, pyPx, mapped)
    val wx = mapped[0].toDouble()
    val wy = mapped[1].toDouble()
    val p = pressure.coerceIn(0f, 1f)
    s.lastRaw = InkPt(wx.toFloat(), wy.toFloat(), t, p, 1f, tilt)
    val last = s.points[s.points.size - 1]
    // Historical samples can repeat the previous timestamp; keep time monotonic.
    val tt = max(t, last.t + 0.01)
    s.filter.filter(wx, wy, tt, tmp)
    val fx = tmp[0].toFloat()
    val fy = tmp[1].toFloat()
    val step = hypot(fx - last.x, fy - last.y)
    if (step < MIN_SAMPLE_DISTANCE) return
    s.length += step
    s.points.add(InkPt(fx, fy, tt, p, 1f, tilt))
    InkGeometry.annotateWidth(s.points, s.points.size - 1, InkGeometry.profile(s.tool))
  }

  private fun finishStroke(ev: MotionEvent, idx: Int) {
    val s = current ?: return
    cancelHold()
    if (s.shape == null && idx >= 0 && idx < ev.pointerCount) {
      addSample(s, ev.getX(idx), ev.getY(idx), ev.getPressure(idx), ev.eventTime.toDouble(), ev.getAxisValue(MotionEvent.AXIS_TILT, idx))
    }
    // No extra point at the exact lift position: the line ends where it was
    // already drawn, so lifting the pen can't make it jump forward.
    current = null
    activePointerId = -1
    prediction = emptyList()

    // Keep drawing it (finished, with its exit taper, exactly as JS will) until
    // JavaScript reports it has drawn it, so there's no blank frame in between.
    val done = drawFor(s, s.points, true)
    s.finished = done
    val dry = DryInkView.find(dryGroup)
    if (dry != null) {
      // Same path, same canvas type: the stored copy looks exactly like the
      // wet one. onDraw ink moves over within this frame (both views draw in
      // the same traversal), so there is no swap to see.
      dry.addProvisional(DryInkView.fromDraw(s.id, done))
      if (s.onFront) {
        // The front buffer is a separate surface and updates at once, so it
        // keeps the stroke until the frame with the stored copy is on screen.
        pending.add(s)
        pendingDirty = false
        front?.show(pendingDraws(), transform())
        val ch = android.view.Choreographer.getInstance()
        ch.postFrameCallback {
          ch.postFrameCallback {
            if (pending.remove(s)) refreshPending()
          }
        }
      }
      invalidate()
    } else {
      pending.add(s)
      pendingDirty = false
      // The wet stroke was already drawn with its exit taper, so this redraw
      // changes nothing visible: only the prediction tip goes.
      val f = front
      if (s.onFront && f != null) f.show(pendingDraws(), transform()) else invalidate()
    }

    val flat = ArrayList<Double>(s.points.size * 6)
    for (pt in s.points) {
      flat.add(pt.x.toDouble())
      flat.add(pt.y.toDouble())
      flat.add(pt.t)
      flat.add(pt.p.toDouble())
      flat.add(pt.w.toDouble())
      flat.add(pt.a.toDouble())
    }
    val event = HashMap<String, Any>()
    event["id"] = s.id
    event["tool"] = s.tool
    event["points"] = flat
    event["stride"] = 6
    s.shape?.let { event["shape"] = it }
    onStroke(event)
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
    val ahead = min(speed * PREDICT_AHEAD_MS, s.width * 2f)
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
    val shader = if (s.tool == "pencil") InkGrain.shader(s.color) else null
    return StrokeDraw(InkGeometry.buildPath(pts, s.width, s.tool, finished, s.shape != null), s.color, alpha, stroked, s.width, shader)
  }

  private fun pendingDraws(): List<StrokeDraw> = pending.mapNotNull { if (it.onFront) it.finished else null }

  private fun showWet(s: WetStroke) {
    val f = front
    // Only fully opaque ink goes on the front buffer. See-through ink would
    // darken for a frame wherever the front copy overlaps the stored one.
    s.onFront = f != null && s.opacity >= 1f && Color.alpha(s.color) == 255
    if (f == null || !s.onFront) {
      invalidate()
      return
    }
    val op = incrementalOp(s)
    if (op != null) {
      f.renderWet(op)
      return
    }
    // Full redraw: clear, then the strokes still waiting and the whole wet
    // stroke with its prediction.
    val pts: List<InkPt> = if (prediction.isEmpty()) s.points else s.points + prediction
    f.renderWet(WetOp(true, pendingDraws() + drawFor(s, pts, true), transform()))
  }

  /**
   * Redrawing the whole wet stroke on every sample costs time in proportion
   * to the screen area it covers, so it grew with stroke length and with zoom
   * (3x zoom: 9x the pixels), and ink fell behind the pen. For opaque ink the
   * front buffer can instead keep what's drawn and take only the new piece:
   *
   *  - A segment's exact outline depends on its neighbours, so it's final
   *    once three more samples exist. Final segments are drawn once, exactly
   *    as the finished stroke will be, overlapping the previous piece by one
   *    segment so no seam shows.
   *  - The newest few segments are drawn as plain straight pieces, which lie
   *    inside the final outline, and are overdrawn when they become final.
   *  - The start taper depends on the stroke's total length until the stroke
   *    is long enough, so until then the whole (short, cheap) stroke is
   *    redrawn as before.
   *
   * See-through ink can't be layered like this (overlaps would darken), so
   * it returns null and keeps the full redraw. No prediction is drawn here:
   * nothing added to the buffer can be taken back until the pen lifts.
   */
  private fun incrementalOp(s: WetStroke): WetOp? {
    if (s.shape != null) return null // a snapped shape replaces everything: full redraw
    if (s.opacity < 1f || Color.alpha(s.color) != 255) return null
    val prof = InkGeometry.profile(s.tool)
    val n = s.points.size
    var clear = false
    if (!s.incremental) {
      if (n < 6 || s.length < 2.5f * prof.taperStart * s.width + 0.5f) return null
      s.incremental = true
      s.drawnTo = 0
      s.patched.clear()
      clear = true // this op lays down everything so far
    }
    val alpha = 255
    val draws = ArrayList<StrokeDraw>(8)
    if (clear) draws.addAll(pendingDraws()) // the clear wipes them too
    if (prof.constantWidth) {
      // Spine tools (fineliner): a segment's spline is final two samples on.
      val stableEnd = n - 3
      if (stableEnd >= s.drawnTo) {
        val a = max(0, s.drawnTo - 1)
        draws.add(StrokeDraw(InkGeometry.spinePiecePath(s.points, a, stableEnd), s.color, alpha, true, s.width))
        s.drawnTo = stableEnd + 1
      }
      val tail = android.graphics.Path()
      val from = max(0, s.drawnTo - 1)
      tail.moveTo(s.points[from].x, s.points[from].y)
      for (k in from + 1 until n) tail.lineTo(s.points[k].x, s.points[k].y)
      draws.add(StrokeDraw(tail, s.color, alpha, true, s.width))
      return WetOp(clear, draws, transform())
    }
    // Drawn with the exit taper at the nib, as if the pen lifted now, so
    // lifting it changes nothing. A segment is final once it is three samples
    // back AND clear of that taper (which moves on as the stroke grows).
    val d = InkGeometry.computeOutline(s.points, s.width, s.tool, true) ?: return null
    val endLen = InkGeometry.endTaperLength(s.points, s.width, prof)
    var stableEnd = n - 4
    if (endLen > 0f) {
      var tipDist = 0f
      var j = n - 1
      // Walk back from the tip until the taper has ended; points before that are untapered.
      while (j > 0 && tipDist < endLen) {
        tipDist += hypot(s.points[j].x - s.points[j - 1].x, s.points[j].y - s.points[j - 1].y)
        j--
      }
      // Point j is the first one (from the tip) at or beyond the taper; segments
      // up to j - 4 use only untapered outline points.
      stableEnd = min(stableEnd, j - 4)
    }
    if (clear) {
      // Round start, as the full outline has (the forward half lies inside).
      val cap = android.graphics.Path()
      cap.addCircle(d.xs[0], d.ys[0], d.hw[0], android.graphics.Path.Direction.CW)
      draws.add(StrokeDraw(cap, s.color, alpha, false, s.width))
    }
    if (stableEnd >= 0 && stableEnd >= s.drawnTo) {
      val a = max(0, s.drawnTo - 1)
      draws.add(StrokeDraw(InkGeometry.piecePath(d, a, stableEnd), s.color, alpha, false, s.width))
      s.drawnTo = stableEnd + 1
    }
    // Fold patches can be decided a little after a segment is drawn.
    val flags = InkGeometry.patchFlags(d)
    val lastFinal = min(stableEnd, flags.size - 1)
    for (k in 0..lastFinal) {
      if (flags[k] && s.patched.add(k)) {
        draws.add(StrokeDraw(InkGeometry.segmentQuadPath(d, k), s.color, alpha, false, s.width))
      }
    }
    // Provisional tail up to the nib.
    for (k in max(0, s.drawnTo - 1)..n - 2) {
      draws.add(StrokeDraw(InkGeometry.segmentQuadPath(d, k), s.color, alpha, false, s.width))
    }
    return WetOp(clear, draws, transform())
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
    f.show(pendingDraws(), transform())
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    drawStrokes(canvas)
    drawSelection(canvas)
    drawCursor(canvas)
  }

  private fun drawStrokes(canvas: Canvas) {
    // Front-buffer ink is drawn on that layer; everything else here.
    val s = current?.takeIf { !it.onFront || front == null }
    val waiting = pending.any { !it.onFront || front == null }
    if (!waiting && s == null) return
    canvas.save()
    transform().apply(canvas)
    for (p in pending) if (!p.onFront || front == null) p.finished?.draw(canvas, fillPaint, strokePaint)
    if (s != null && s.points.isNotEmpty()) {
      val pts: List<InkPt> = if (prediction.isEmpty()) s.points else s.points + prediction
      // With the exit taper, as it will look once the pen lifts.
      drawFor(s, pts, true).draw(canvas, fillPaint, strokePaint)
    }
    canvas.restore()
  }


  companion object {
    /** Shared by every ink view (main canvas and zoom pad), so ids never clash. */
    private val STROKE_IDS = java.util.concurrent.atomic.AtomicInteger(1)
    private const val TAG = "GeodesicInk"
    private const val MIN_SAMPLE_DISTANCE = 0.25f
    private const val PREDICT_WINDOW_MS = 24.0
    private const val PREDICT_AHEAD_MS = 8f
    private const val HOLD_MS = 450L
    private const val HOLD_SLOP_DP = 3f
  }
}
