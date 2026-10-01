/** Thin client for the FastAPI backend. Vite proxies /api -> :8777 (see vite.config.js). */

async function j(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) {
    let detail = `${r.status} ${r.statusText}`;
    try {
      const b = await r.json();
      if (b.detail) detail = typeof b.detail === "string" ? b.detail : JSON.stringify(b.detail);
    } catch { /* non-JSON error body */ }
    throw new Error(detail);
  }
  return r.json();
}

const post = (url, body) =>
  j(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

export const api = {
  datasets: () => j("/api/datasets"),
  room: (id) => j(`/api/room/${encodeURIComponent(id)}`),
  roomMesh: (id) => j(`/api/room/${encodeURIComponent(id)}/mesh`),
  splatInfo: (id) => j(`/api/splat/${id}/info`),
  splatSogUrl: (id) => `/api/splat/${id}/sog`,

  async sdfBin(id) {
    const r = await fetch(`/api/room/${encodeURIComponent(id)}/sdf.bin`);
    if (!r.ok) throw new Error(`sdf.bin: ${r.status}`);
    return r.arrayBuffer();
  },

  /** Bake an SDF for a client-drawn footprint (custom box). */
  async customSdf(footprint) {
    const r = await fetch("/api/sdf.bin", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ footprint }),
    });
    if (!r.ok) throw new Error(`custom sdf: ${r.status}`);
    return r.arrayBuffer();
  },

  /** Solve on the server so the preview transform is literally what the export will use. */
  solve: (pairs, yawOnly, refine = null, roomId = null) =>
    post("/api/solve", { pairs, yaw_only: yawOnly, refine, room_id: roomId }),

  /** Compose the manual refine onto a custom box's fixed base transform (server-side, for parity). */
  solveCustom: (baseMatrix4, refine, pivotHeight) =>
    post("/api/solve", { base_matrix4: baseMatrix4, refine, pivot_height: pivotHeight }),
  export: (body) => post("/api/export", body),

  /** Detect the room box from the splat alone (no IFC). Reopen-shaped payload for Clean. */
  autoRoom: (id) => j(`/api/auto_room/${id}`, { method: "POST" }),

  /** Previously exported cleans, each with a `reload` payload for re-opening in Clean. */
  exports: () => j("/api/exports"),
};
