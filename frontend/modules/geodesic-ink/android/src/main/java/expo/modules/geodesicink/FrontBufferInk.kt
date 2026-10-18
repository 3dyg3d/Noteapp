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
  @JvmField val width: Float,
  /** Texture (pencil grain) carrying the colour; null for plain ink. */
  @JvmField val shader: android.graphics.Shader? = null
) {
  fun draw(canvas: Canvas, fill: Paint, stroke: Paint) {
    val p = if (stroked) stroke else fill
    if (shader != null) {
      p.shader = shader
      p.color = Color.BLACK // colour comes from the shader
      p.alpha = alpha
    } else {
      p.shader = null
      p.color = color
      p.alpha = min(alpha, Color.alpha(color))
    }
    if (stroked) p.strokeWidth = width
    canvas.drawPath(path, p)
    p.shader = null
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

/**
 * One update to the wet stroke on the front buffer. `clear` wipes the buffer
 * first (used while the whole stroke is redrawn); otherwise `draws` are added
 * on top of what is already there, which is how long strokes stay cheap.
 */
class WetOp(
  @JvmField val clear: Boolean,
  @JvmField val draws: List<StrokeDraw>,
  @JvmField val transform: InkTransform
)

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
 *
 * Everything this layer shows lives on that one front buffer: the wet stroke
 * and the finished strokes the app hasn't drawn yet. The library's commit /
 * multi-buffered path is deliberately not used. Its commit() holds back every
 * later front-buffer draw until the compositor releases the committed buffer,
 * and that release only comes after yet another commit; writing quickly (the
 * next stroke starting before the app took over the last one) left the wet
 * ink invisible until the pen lifted.
 *
 * A transparent SurfaceView placed above the app window carries the layer.
 * It's transparent except where ink is waiting, so the Skia canvas and the
 * rest of the UI show through it.
 *
 * Rendering happens on the library's own thread; ops are immutable.
 */
@RequiresApi(29)
class FrontBufferInk(context: Context, private val host: ViewGroup) {

  val surfaceView: SurfaceView = SurfaceView(context).apply {
    setZOrderOnTop(true)
    holder.setFormat(PixelFormat.TRANSLUCENT)
  }

  // Owned by the render thread.
  private val fill = newFillPaint()
  private val stroke = newStrokePaint()

  private val renderer: CanvasFrontBufferedRenderer<WetOp>

  init {
    host.addView(
      surfaceView,
      ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
    )
    renderer = CanvasFrontBufferedRenderer(
      surfaceView,
      object : CanvasFrontBufferedRenderer.Callback<WetOp> {
        override fun onDrawFrontBufferedLayer(canvas: Canvas, bufferWidth: Int, bufferHeight: Int, param: WetOp) {
          // Ops are drawn in order onto a buffer that keeps its contents, so
          // an op only needs to add the newest piece unless it clears.
          if (param.clear) canvas.drawColor(Color.TRANSPARENT, PorterDuff.Mode.CLEAR)
          if (param.draws.isEmpty()) return
          canvas.save()
          param.transform.apply(canvas)
          for (d in param.draws) d.draw(canvas, fill, stroke)
          canvas.restore()
        }

        override fun onDrawMultiBufferedLayer(
          canvas: Canvas,
          bufferWidth: Int,
          bufferHeight: Int,
          params: Collection<WetOp>
        ) {
          // Unused (see above); keep it empty if the library ever calls it.
          canvas.drawColor(Color.TRANSPARENT, PorterDuff.Mode.CLEAR)
        }
      }
    )
  }

  /** Add to (or, with clear, replace) what the layer shows. UI thread. */
  fun renderWet(op: WetOp) {
    renderer.renderFrontBufferedLayer(op)
  }

  /** Replace everything on the layer with these strokes (none = empty). */
  fun show(draws: List<StrokeDraw>, transform: InkTransform) {
    renderer.renderFrontBufferedLayer(WetOp(true, draws, transform))
  }

  fun release() {
    renderer.release(true)
    host.removeView(surfaceView)
  }
}
