"""Minimal reader/writer for the 3DGS binary PLY these scans use.

Deliberately narrow: binary_little_endian, one `element vertex`, all-float32 properties. That is
exactly what `gs.ply` is, and refusing anything else beats silently misreading it.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

# The 14 properties in gs.ply, in file order.
GS_PROPS = [
    "x", "y", "z",
    "f_dc_0", "f_dc_1", "f_dc_2",
    "opacity",
    "scale_0", "scale_1", "scale_2",
    "rot_0", "rot_1", "rot_2", "rot_3",
]


class PlyError(Exception):
    pass


def read_header(path: str | Path) -> tuple[int, list[str], int]:
    """-> (vertex_count, property_names, header_byte_length)"""
    path = Path(path)
    with open(path, "rb") as f:
        buf = b""
        while b"end_header\n" not in buf:
            chunk = f.read(4096)
            if not chunk:
                raise PlyError("no end_header found")
            buf += chunk
            if len(buf) > 1 << 20:
                raise PlyError("header unreasonably large")
    end = buf.index(b"end_header\n") + len(b"end_header\n")
    lines = buf[:end].decode("ascii", "replace").splitlines()

    if not lines or lines[0].strip() != "ply":
        raise PlyError("not a PLY file")
    if not any(l.strip() == "format binary_little_endian 1.0" for l in lines):
        raise PlyError("only binary_little_endian 1.0 is supported")

    count, props, in_vertex = None, [], False
    for line in lines:
        p = line.split()
        if not p:
            continue
        if p[0] == "element":
            in_vertex = p[1] == "vertex"
            if in_vertex:
                count = int(p[2])
        elif p[0] == "property" and in_vertex:
            if p[1] != "float" and p[1] != "float32":
                raise PlyError(f"non-float property {p[-1]} ({p[1]}) is not supported")
            props.append(p[-1])
    if count is None:
        raise PlyError("no vertex element")
    return count, props, end


def read(path: str | Path) -> tuple[np.ndarray, list[str]]:
    """Memory-map the vertex block -> (count, nprops) float32 view, property names."""
    count, props, off = read_header(path)
    data = np.memmap(path, dtype="<f4", mode="r", offset=off, shape=(count, len(props)))
    return data, props


def write(path: str | Path, data: np.ndarray, props: list[str]) -> None:
    if data.ndim != 2 or data.shape[1] != len(props):
        raise PlyError(f"data {data.shape} does not match {len(props)} properties")
    header = ["ply", "format binary_little_endian 1.0", f"element vertex {len(data)}"]
    header += [f"property float {p}" for p in props]
    header += ["end_header", ""]
    with open(path, "wb") as f:
        f.write("\n".join(header).encode("ascii"))
        np.ascontiguousarray(data, dtype="<f4").tofile(f)
