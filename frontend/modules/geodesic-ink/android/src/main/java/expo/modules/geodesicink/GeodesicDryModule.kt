package expo.modules.geodesicink

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.typedarray.Float32Array
import java.nio.ByteOrder

/** The note's stored ink, drawn natively: see [DryInkView]. */
class GeodesicDryModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("GeodesicDry")

    // Synchronous so the typed array can be read in place; the copy is quick
    // and everything else happens on a worker thread.
    Function("sync") { group: String, meta: String, data: Float32Array ->
      val out = FloatArray(data.length)
      if (out.isNotEmpty()) {
        data.toDirectBuffer().order(ByteOrder.nativeOrder()).asFloatBuffer().get(out)
      }
      DryInkView.sync(group, meta, out)
    }

    View(DryInkView::class) {
      Events("onReady")

      Prop("group") { view: DryInkView, value: String ->
        view.group = value
      }
      Prop("viewTransform") { view: DryInkView, value: List<Double> ->
        view.setViewTransform(value)
      }
      Prop("pages") { view: DryInkView, value: List<Double> ->
        view.setPages(value)
      }
    }
  }
}
