package expo.modules.geodesicink

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.PorterDuff
import android.view.SurfaceView
import android.view.ViewGroup
import androidx.annotation.RequiresApi
import androidx.graphics.lowlatency.CanvasFrontBufferedRenderer
import kotlin.math.min

/** One stroke ready to draw: an immutable path plus how to paint it. */
class StrokeDraw(
  @JvmField val path: Path,
  @JvmField val color: Int,
  @JvmField val alpha: Int,
  /** Constant-width tools (highlighter) are a stroked spine; others a filled outline. */
  @JvmField val stroked: Boolean,
  @JvmField val width: Float
) {
  fun draw(canvas: Canvas, fill: Paint, stroke: Paint) {
    if (stroked) {
      stroke.color = color
      stroke.alpha = min(alpha, Color.alpha(color))
      stroke.strokeWidth = width
      canvas.drawPath(path, stroke)
    } else {
      fill.color = color
      fill.alpha = min(alpha, Color.alpha(color))
      canvas.drawPath(path, fill)
    }
  }
}

/** World-to-pixel mapping and the page area strokes are clipped to. Immutable. */
class InkTransform(
  @JvmField val scalePx: Float,
  @JvmField val txPx: Float,
  @JvmField val tyPx: Float,
  @JvmField val clipW: Float,
  @JvmField val clipH: Float
) {
  fun apply(canvas: Canvas) {
    canvas.translate(txPx, tyPx)
    canvas.scale(scalePx, scalePx)
    if (clipW > 0f && clipH > 0f) canvas.clipRect(0f, 0f, clipW, clipH)
  }
}

fun newFillPaint() = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
fun newStrokePaint() = Paint(Paint.ANTI_ALIAS_FLAG).apply {
  style = Paint.Style.STROKE
  strokeCap = Paint.Cap.ROUND
  strokeJoin = Paint.Join.ROUND
}

/**
 * Front-buffered wet ink (Android 10+).
 *
 * The stroke being written is drawn into a buffer that is ALREADY ON SCREEN,
 * instead of into the next frame, which removes a frame or more of delay.
 * Front-buffer drawing can tear for a moment, so it is used only for the wet
 * stroke; finished strokes waiting for the app to take them over are drawn on
 * the normal (multi-buffered) layer underneath.
 *
 * A transparent SurfaceView placed above the app window carries both layers.
 * It's empty (fully transparent) except while ink is being written, so the
 * Skia canvas and the rest of the UI show through it.
 *
 * Rendering happens on the library's own thread. The UI thread publishes
 * immutable snapshots through volatile fields; the render callbacks draw
 * whatever is newest.
 */
@RequiresApi(29)
class FrontBufferInk(context: Context, private val host: ViewGroup) {

  val surfaceView: SurfaceView = SurfaceView(context).apply {
    setZOrderOnTop(true)
    holder.setFormat(PixelFormat.TRANSLUCENT)
  }

  @Volatile private var wet: StrokeDraw? = null
  @Volatile private var wetTransform: InkTransform? = null
  @Volatile private var pending: List<StrokeDraw> = emptyList()
  @Volatile private var pendingTransform: InkTransform? = null

  // Owned by the render thread.
  private val fill = newFillPaint()
  private val stroke = newStrokePaint()

  private var seq = 0
  private val renderer: CanvasFrontBufferedRenderer<Int>

  init {
    host.addView(
      surfaceView,
      ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
    )
    renderer = CanvasFrontBufferedRenderer(
      surfaceView,
      object : CanvasFrontBufferedRenderer.Callback<Int> {
        override fun onDrawFrontBufferedLayer(canvas: Canvas, bufferWidth: Int, bufferHeight: Int, param: Int) {
          // Redraw the whole wet stroke each time: the prediction at its tip
          // must disappear when real samples replace it.
          canvas.drawColor(Color.TRANSPARENT, PorterDuff.Mode.CLEAR)
          val s = wet ?: return
          val t = wetTransform ?: return
          canvas.save()
          t.apply(canvas)
          s.draw(canvas, fill, stroke)
          canvas.restore()
        }

        override fun onDrawMultiBufferedLayer(
          canvas: Canvas,
          bufferWidth: Int,
          bufferHeight: Int,
          params: Collection<Int>
        ) {
          canvas.drawColor(Color.TRANSPARENT, PorterDuff.Mode.CLEAR)
          val list = pending
          val t = pendingTransform ?: return
          if (list.isEmpty()) return
          canvas.save()
          t.apply(canvas)
          for (s in list) s.draw(canvas, fill, stroke)
          canvas.restore()
        }
      }
    )
  }

  /** Show the stroke being written (UI thread). */
  fun renderWet(stroke: StrokeDraw, transform: InkTransform) {
    wet = stroke
    wetTransform = transform
    renderer.renderFrontBufferedLayer(++seq)
  }

  /**
   * The pen lifted: hide the front layer and draw the finished strokes on the
   * normal layer until the app has drawn them itself.
   */
  fun commit(finished: List<StrokeDraw>, transform: InkTransform) {
    pending = finished
    pendingTransform = transform
    wet = null
    renderer.commit()
  }

  /** Redraw the normal layer after strokes were handed over (or the view moved). */
  fun showPending(finished: List<StrokeDraw>, transform: InkTransform) {
    pending = finished
    pendingTransform = transform
    if (finished.isEmpty()) renderer.clear() else renderer.renderMultiBufferedLayer(emptyList())
  }

  /** Touch cancelled (palm, system gesture): drop the wet stroke. */
  fun cancel() {
    wet = null
    renderer.cancel()
  }

  fun release() {
    renderer.release(true)
    host.removeView(surfaceView)
  }
}
