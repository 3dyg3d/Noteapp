package expo.modules.geodesicink

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.pdf.PdfDocument
import android.os.Build
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Exports a handwritten note as a PDF (vector ink) or one page as a PNG.
 *
 * Strokes are rebuilt with the same geometry as the screen (InkGeometry), so
 * the export matches what you see, and in a PDF they stay sharp at any zoom.
 * Paper templates are a port of src/components/SkiaPaper.tsx.
 */
object DocExporter {

  fun export(context: Context, json: String): String {
    val o = JSONObject(json)
    val format = o.optString("format", "pdf")
    val pageW = o.getDouble("pageW").toFloat()
    val pageH = o.getDouble("pageH").toFloat()
    val stride = o.getDouble("stride").toFloat()
    val pages = o.getJSONArray("pages")
    val name = o.optString("name", "note").replace(Regex("[^A-Za-z0-9 _.-]"), "").trim().ifEmpty { "note" }
    val dir = File(context.cacheDir, "exports").apply { mkdirs() }
    val images = o.optJSONArray("images") ?: JSONArray()
    val decoded = HashMap<Int, Bitmap?>()
    val bitmapFor = { ref: Int ->
      decoded.getOrPut(ref) {
        val uri = images.optString(ref, "")
        if (uri.isEmpty()) null else try {
          val bytes = Base64.decode(uri.substring(uri.indexOf(',') + 1), Base64.DEFAULT)
          BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        } catch (e: Exception) {
          null
        }
      }
    }

    if (format == "png") {
      val pageIndex = pages.getInt(0)
      val targetW = o.optInt("pngWidth", 2400)
      val k = targetW / pageW
      val bmp = Bitmap.createBitmap(targetW, max(1, (pageH * k).roundToInt()), Bitmap.Config.ARGB_8888)
      val canvas = Canvas(bmp)
      canvas.scale(k, k)
      drawPage(canvas, o, pageIndex, pageW, pageH, stride, bitmapFor)
      val file = File(dir, "$name - page ${pageIndex + 1}.png")
      FileOutputStream(file).use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
      bmp.recycle()
      return file.absolutePath
    }

    // PDF: page size in points; width from the note (an imported PDF keeps its own).
    val outW = o.optDouble("outW", 595.0).toFloat()
    val k = outW / pageW
    val outH = pageH * k
    val doc = PdfDocument()
    try {
      for (n in 0 until pages.length()) {
        val pageIndex = pages.getInt(n)
        val info = PdfDocument.PageInfo.Builder(outW.roundToInt(), outH.roundToInt(), n + 1).create()
        val page = doc.startPage(info)
        page.canvas.scale(k, k)
        drawPage(page.canvas, o, pageIndex, pageW, pageH, stride, bitmapFor)
        doc.finishPage(page)
      }
      val file = File(dir, "$name.pdf")
      FileOutputStream(file).use { doc.writeTo(it) }
      return file.absolutePath
    } finally {
      doc.close()
      for (b in decoded.values) b?.recycle()
    }
  }

  /** One page in page-local world units (0..pageW, 0..pageH). */
  private fun drawPage(
    canvas: Canvas, o: JSONObject, pageIndex: Int, pageW: Float, pageH: Float, stride: Float,
    bitmapFor: (Int) -> Bitmap?
  ) {
    val includePaper = o.optBoolean("includePaper", true)
    val paperColor = parseColor(o.optString("paperColor", "#FFFFFF"), Color.WHITE)
    val lineColor = parseColor(o.optString("lineColor", "#C9C2B0"), Color.LTGRAY)
    canvas.save()
    canvas.clipRect(0f, 0f, pageW, pageH)
    if (includePaper) {
      // A page can have its own paper; otherwise the note's.
      val tpls = o.optJSONArray("pageTemplates")
      val paperType = if (tpls != null && pageIndex < tpls.length() && !tpls.isNull(pageIndex)) tpls.getString(pageIndex) else o.optString("paper", "blank")
      drawPaper(canvas, paperType, paperColor, lineColor, pageW, pageH,
        if (o.isNull("lineSpacing") || !o.has("lineSpacing")) null else o.getDouble("lineSpacing").toFloat())
    } else {
      canvas.drawColor(Color.WHITE)
    }
    // Imported PDF page behind the ink, fitted like the screen ("contain").
    val bgs = o.optJSONArray("backgrounds")
    if (bgs != null && pageIndex < bgs.length() && !bgs.isNull(pageIndex)) {
      bitmapFor(bgs.getInt(pageIndex))?.let { bmp ->
        val s = min(pageW / bmp.width, pageH / bmp.height)
        val w = bmp.width * s; val h = bmp.height * s
        val l = (pageW - w) / 2; val t = (pageH - h) / 2
        canvas.drawBitmap(bmp, null, RectF(l, t, l + w, t + h), Paint(Paint.FILTER_BITMAP_FLAG))
      }
    }
    // Items, in world coordinates shifted to this page.
    canvas.translate(0f, -pageIndex * stride)
    val items = o.getJSONArray("items")
    val fill = newFillPaint()
    val strokeP = newStrokePaint()
    val top = pageIndex * stride
    for (i in 0 until items.length()) {
      val it = items.getJSONObject(i)
      if (!onPage(it, top, top + pageH)) continue
      when (it.optString("kind", "stroke")) {
        "stroke" -> drawStroke(canvas, it, fill, strokeP)
        "shape" -> drawShape(canvas, it, strokeP)
        "image" -> drawImage(canvas, it, bitmapFor)
        "text" -> drawText(canvas, it)
      }
    }
    canvas.restore()
  }

  /** Cheap overlap test so a long notebook doesn't redraw every item on every page. */
  private fun onPage(it: JSONObject, y0: Float, y1: Float): Boolean {
    var lo = Float.MAX_VALUE; var hi = -Float.MAX_VALUE
    when (it.optString("kind", "stroke")) {
      "stroke" -> {
        val pts = it.optJSONArray("points") ?: return false
        for (k in 0 until pts.length()) {
          val y = pts.getJSONObject(k).getDouble("y").toFloat()
          lo = min(lo, y); hi = max(hi, y)
        }
        val pad = it.optDouble("width", 2.0).toFloat() * 3f
        lo -= pad; hi += pad
      }
      "shape" -> {
        val a = it.getJSONObject("start").getDouble("y").toFloat()
        val b = it.getJSONObject("end").getDouble("y").toFloat()
        lo = min(a, b) - 20f; hi = max(a, b) + 20f
      }
      else -> {
        val y = it.getDouble("y").toFloat(); val h = it.getDouble("h").toFloat()
        val w = it.optDouble("w", 0.0).toFloat()
        lo = y - w; hi = y + h + w // generous: allows for rotation
      }
    }
    return hi >= y0 && lo <= y1
  }

  private fun drawStroke(canvas: Canvas, it: JSONObject, fill: Paint, strokeP: Paint) {
    val tool = it.optString("tool", "pen")
    val color = parseColor(it.optString("color", "#000000"), Color.BLACK)
    val arr = it.optJSONArray("points") ?: return
    val pts = ArrayList<InkPt>(arr.length())
    var missingW = false
    for (k in 0 until arr.length()) {
      val p = arr.getJSONObject(k)
      val w = if (p.has("w")) p.getDouble("w").toFloat() else { missingW = true; 1f }
      pts.add(
        InkPt(
          p.getDouble("x").toFloat(), p.getDouble("y").toFloat(), p.optDouble("t", k * 4.0),
          p.optDouble("p", 0.55).toFloat(), w, p.optDouble("a", 0.0).toFloat()
        )
      )
    }
    if (pts.isEmpty()) return
    if (missingW) for (k in pts.indices) InkGeometry.annotateWidth(pts, k, InkGeometry.profile(tool))
    val width = InkGeometry.effectiveWidth(tool, it.optDouble("width", 2.0).toFloat())
    val shape = it.has("shape")
    val path = InkGeometry.buildPath(pts, width, tool, true, shape)
    val alpha = min((InkGeometry.opacity(tool) * 255f).roundToInt(), Color.alpha(color))
    val stroked = InkGeometry.profile(tool).constantWidth && pts.size > 1
    val shader = if (tool == "pencil") InkGrain.shader(color) else null
    StrokeDraw(path, color, alpha, stroked, width, shader).draw(canvas, fill, strokeP)
  }

  private fun drawShape(canvas: Canvas, it: JSONObject, p: Paint) {
    val s = it.getJSONObject("start"); val e = it.getJSONObject("end")
    val x0 = s.getDouble("x").toFloat(); val y0 = s.getDouble("y").toFloat()
    val x1 = e.getDouble("x").toFloat(); val y1 = e.getDouble("y").toFloat()
    p.shader = null
    p.color = parseColor(it.optString("color", "#000000"), Color.BLACK)
    p.strokeWidth = it.optDouble("width", 2.0).toFloat()
    val path = Path()
    when (it.optString("tool", "line")) {
      "rect" -> path.addRect(min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1), Path.Direction.CW)
      "ellipse" -> path.addOval(RectF(min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)), Path.Direction.CW)
      else -> { path.moveTo(x0, y0); path.lineTo(x1, y1) }
    }
    canvas.drawPath(path, p)
  }

  private fun drawImage(canvas: Canvas, it: JSONObject, bitmapFor: (Int) -> Bitmap?) {
    val bmp = bitmapFor(it.optInt("ref", -1)) ?: return
    val x = it.getDouble("x").toFloat(); val y = it.getDouble("y").toFloat()
    val w = it.getDouble("w").toFloat(); val h = it.getDouble("h").toFloat()
    canvas.save()
    canvas.rotate(Math.toDegrees(it.optDouble("angle", 0.0)).toFloat(), x + w / 2, y + h / 2)
    canvas.drawBitmap(bmp, null, RectF(x, y, x + w, y + h), Paint(Paint.FILTER_BITMAP_FLAG))
    canvas.restore()
  }

  private fun drawText(canvas: Canvas, it: JSONObject) {
    val text = it.optString("text", "")
    if (text.isEmpty()) return
    val x = it.getDouble("x").toFloat(); val y = it.getDouble("y").toFloat()
    val w = max(10f, it.getDouble("w").toFloat()); val h = it.optDouble("h", 0.0).toFloat()
    val paint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
      color = parseColor(it.optString("color", "#000000"), Color.BLACK)
      textSize = it.optDouble("fontSize", 18.0).toFloat()
    }
    val layout = if (Build.VERSION.SDK_INT >= 23) {
      StaticLayout.Builder.obtain(text, 0, text.length, paint, w.roundToInt()).build()
    } else {
      @Suppress("DEPRECATION")
      StaticLayout(text, paint, w.roundToInt(), Layout.Alignment.ALIGN_NORMAL, 1f, 0f, false)
    }
    canvas.save()
    canvas.rotate(Math.toDegrees(it.optDouble("angle", 0.0)).toFloat(), x + w / 2, y + max(h, layout.height.toFloat()) / 2)
    canvas.translate(x, y)
    layout.draw(canvas)
    canvas.restore()
  }

  /** Port of SkiaPaper.tsx. */
  private fun drawPaper(canvas: Canvas, type: String, color: Int, line: Int, width: Float, height: Float, spacing: Float?) {
    canvas.drawColor(color)
    val p = Paint(Paint.ANTI_ALIAS_FLAG).apply { this.color = line; strokeWidth = 1f; style = Paint.Style.STROKE }
    val dot = Paint(Paint.ANTI_ALIAS_FLAG).apply { this.color = line; style = Paint.Style.FILL }
    fun hLine(y: Float, w: Float = 1f, x0: Float = 0f, x1: Float = width) { p.strokeWidth = w; canvas.drawLine(x0, y, x1, y, p) }
    when (type) {
      "ruled", "narrow" -> {
        val step = if (type == "ruled") max(8f, spacing ?: 32f) else max(6f, spacing ?: 20f)
        var y = step; while (y < height) { hLine(y); y += step }
      }
      "grid" -> {
        val step = max(8f, spacing ?: 24f)
        var y = 0f; while (y < height) { hLine(y); y += step }
        var x = 0f; while (x < width) { p.strokeWidth = 1f; canvas.drawLine(x, 0f, x, height, p); x += step }
      }
      "dotted" -> {
        val step = max(8f, spacing ?: 24f)
        var y = step / 2
        while (y < height) {
          var x = step / 2
          while (x < width) { canvas.drawCircle(x, y, 1.4f, dot); x += step }
          y += step
        }
      }
      "engineering" -> {
        val step = max(8f, spacing ?: 20f)
        var y = 0f; while (y < height) { hLine(y, 0.6f); y += step }
        var x = 0f; while (x < width) { p.strokeWidth = 0.6f; canvas.drawLine(x, 0f, x, height, p); x += step }
        hLine(step * 3, 1.6f)
        p.strokeWidth = 1.6f; canvas.drawLine(step * 2, step * 3, step * 2, height, p)
      }
      "graph" -> {
        val step = max(6f, spacing ?: 12f)
        var k = 0
        var y = 0f; while (y < height) { hLine(y, if (k % 5 == 0) 1.3f else 0.5f); y += step; k++ }
        k = 0
        var x = 0f; while (x < width) { p.strokeWidth = if (k % 5 == 0) 1.3f else 0.5f; canvas.drawLine(x, 0f, x, height, p); x += step; k++ }
      }
      "cornell" -> {
        val step = max(10f, spacing ?: 28f)
        var y = 120f; while (y < height - 80f) { hLine(y); y += step }
        p.strokeWidth = 1.5f; canvas.drawLine(width * 0.3f, 120f, width * 0.3f, height - 80f, p)
        hLine(height - 80f, 1.5f)
        hLine(110f)
      }
      "planner" -> {
        val step = max(10f, spacing ?: 30f)
        hLine(90f, 1.5f)
        hLine(50f, 1f, 20f, width - 20f)
        var y = 100f; while (y < height) { hLine(y); y += step }
      }
      "todo" -> {
        val step = max(12f, spacing ?: 30f)
        var y = step
        while (y < height) {
          p.strokeWidth = 1.2f; canvas.drawRect(18f, y - 7f, 32f, y + 7f, p)
          hLine(y, 1f, 40f, width - 12f)
          y += step
        }
      }
    }
  }

  private fun parseColor(hex: String, fallback: Int): Int = try { Color.parseColor(hex) } catch (e: Exception) { fallback }
}
