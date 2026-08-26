// Triggers a browser file-save for JSON content — backs the admin workflow
// editor's "📥 JSONをダウンロード" buttons (list row + edit modal) so an
// admin can drag the exported file straight onto a ComfyUI canvas instead
// of round-tripping through the clipboard/a text editor.
export function downloadJson(content: unknown, filename: string): void {
  let text: string;
  if (typeof content === "string") {
    try {
      text = JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      // Not (yet) valid JSON — save the raw text as-is rather than
      // blocking the download on validity.
      text = content;
    }
  } else {
    text = JSON.stringify(content, null, 2);
  }

  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}
