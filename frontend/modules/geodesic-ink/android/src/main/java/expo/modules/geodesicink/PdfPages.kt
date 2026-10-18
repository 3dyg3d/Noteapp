package expo.modules.geodesicink

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.util.Base64
import java.io.ByteArrayOutputStream
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Renders the pages of a PDF to JPEG images with Android's built-in
 * PdfRenderer, entirely on the device. Each page becomes the background of a
 * page in a handwritten note.
 */
object PdfPages {
  const val MAX_PAGES = 200

  fun render(context: Context, uri: String, maxWidth: Int, quality: Int): List<Map<String, Any>> {
    val pfd = context.contentResolver.openFileDescriptor(Uri.parse(uri), "r")
      ?: throw IllegalStateException("Couldn't open the file.")
    val out = ArrayList<Map<String, Any>>()
    try {
      val renderer = PdfRenderer(pfd)
      try {
        val count = min(renderer.pageCount, MAX_PAGES)
        for (i in 0 until count) {
          val page = renderer.openPage(i)
          try {
            val w = max(200, maxWidth)
            val h = max(1, (page.height.toFloat() * w / max(1, page.width)).roundToInt())
            val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
            bmp.eraseColor(Color.WHITE) // PDFs assume white paper
            page.render(bmp, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
            val bos = ByteArrayOutputStream()
            bmp.compress(Bitmap.CompressFormat.JPEG, quality.coerceIn(40, 95), bos)
            bmp.recycle()
            out.add(
              mapOf(
                "width" to page.width,
                "height" to page.height,
                "data" to "data:image/jpeg;base64," + Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP)
              )
            )
          } finally {
            page.close()
          }
        }
        if (renderer.pageCount > MAX_PAGES) {
          out.add(mapOf("truncated" to renderer.pageCount))
        }
      } finally {
        renderer.close()
      }
    } finally {
      pfd.close()
    }
    return out
  }
}
