package expo.modules.geodesicink

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Native wet-ink layer for the handwriting canvas.
 *
 * The view sits over the Skia canvas. It takes stylus input directly from
 * Android (every sample, including the batched historical ones), draws the
 * stroke being written without going through JavaScript, and hands the
 * finished stroke to JavaScript, which stores and renders it as before.
 */
class GeodesicInkModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("GeodesicInk")

    View(InkView::class) {
      Events("onStroke")

      Prop("inkEnabled") { view: InkView, value: Boolean ->
        view.setInkEnabled(value)
      }
      Prop("tool") { view: InkView, value: String ->
        view.tool = value
      }
      Prop("inkColor") { view: InkView, value: String ->
        view.setColorHex(value)
      }
      Prop("baseWidth") { view: InkView, value: Double ->
        view.baseWidth = value.toFloat()
      }
      // [scale, tx, ty]: world = (screenDp - t) / scale
      Prop("viewTransform") { view: InkView, value: List<Double> ->
        view.setViewTransform(value)
      }
      // [pageWidth, pageHeight, pageStride, pageCount] in world units
      Prop("pages") { view: InkView, value: List<Double> ->
        view.setPages(value)
      }
      // Strokes with id <= this have been drawn by JavaScript; stop drawing them here.
      Prop("committedId") { view: InkView, value: Int ->
        view.releaseUpTo(value)
      }
    }
  }
}
