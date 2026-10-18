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

    // Export pages as a PDF or one page as a PNG; returns the file path.
    AsyncFunction("exportDoc") { json: String ->
      val context = appContext.reactContext ?: throw IllegalStateException("App isn't ready.")
      DocExporter.export(context, json)
    }

    // Render a PDF's pages to JPEG data URIs (runs off the UI thread).
    AsyncFunction("renderPdf") { uri: String, maxWidth: Int, quality: Int ->
      val context = appContext.reactContext ?: throw IllegalStateException("App isn't ready.")
      PdfPages.render(context, uri, maxWidth, quality)
    }

    View(InkView::class) {
      Events("onStroke", "onErase", "onPenButton", "onSelect")

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
      // [enabled, centreX, centreY, angleDegrees, halfThickness] in dp.
      Prop("ruler") { view: InkView, value: List<Double> ->
        view.setRuler(value)
      }
      // What a stylus touch does: "ink" | "erase" | "lasso" | "rect" | "none".
      Prop("mode") { view: InkView, value: String ->
        view.mode = value
      }
      Prop("accentColor") { view: InkView, value: String ->
        view.setAccentHex(value)
      }
      // Hold the pen still at the end of a stroke to snap it to a clean shape.
      Prop("shapeSnap") { view: InkView, value: Boolean ->
        view.shapeSnap = value
      }
      // S Pen side button: "none" | "eraser" | "undo" | "redo".
      Prop("buttonAction") { view: InkView, value: String ->
        view.buttonAction = value
      }
      // Hover cursor diameter (world units); 0 hides it.
      Prop("cursorWidth") { view: InkView, value: Double ->
        view.cursorWidth = value.toFloat()
      }
      Prop("eraserWidth") { view: InkView, value: Double ->
        view.eraserWidth = value.toFloat()
      }
      // Draw the wet stroke into the on-screen buffer (Android 10+).
      Prop("frontBuffer") { view: InkView, value: Boolean ->
        view.setFrontBuffer(value)
      }
      // The DryInkView that takes finished strokes (same frame, same renderer).
      Prop("dryGroup") { view: InkView, value: String ->
        view.dryGroup = value
      }
      // Strokes with id <= this have been drawn by JavaScript; stop drawing them here.
      Prop("committedId") { view: InkView, value: Int ->
        view.releaseUpTo(value)
      }
    }
  }
}
