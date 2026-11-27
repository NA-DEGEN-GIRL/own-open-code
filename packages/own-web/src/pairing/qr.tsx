// QR code of the pairing link (05 §13.5, 03 §21.2), drawn here from uqr's module matrix: no network, no image
// service, nothing leaves the page. Dark modules on a light quiet zone in both themes (scanners need the contrast).
import { encode } from "uqr"
import { createMemo } from "solid-js"

export function qrPath(value: string) {
  const result = encode(value, { ecc: "M", border: 0 })
  const parts: string[] = []
  result.data.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) parts.push(`M${x} ${y}h1v1h-1z`)
    }),
  )
  return { size: result.size, path: parts.join("") }
}

export function QrCode(props: { readonly value: string; readonly label: string; readonly pixels?: number }) {
  const code = createMemo(() => qrPath(props.value))
  const quiet = 4
  return (
    <svg
      role="img"
      aria-label={props.label}
      data-testid="pairing-qr"
      data-qr-size={code().size}
      width={props.pixels ?? 224}
      height={props.pixels ?? 224}
      viewBox={`${-quiet} ${-quiet} ${code().size + quiet * 2} ${code().size + quiet * 2}`}
      shape-rendering="crispEdges"
      style={{ "border-radius": "8px", background: "#ffffff" }}
    >
      <rect x={-quiet} y={-quiet} width={code().size + quiet * 2} height={code().size + quiet * 2} fill="#ffffff" />
      <path d={code().path} fill="#000000" />
    </svg>
  )
}
