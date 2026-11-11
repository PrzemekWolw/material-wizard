export function addHdr(e) {
  const { gl } = e;

  function hdrCurve(nits) {
    const peak = nits / 100;
    const mid = 0.538;
    const lin = 0.444;
    const toe = 1.28;
    const k = (lin - 1) / (0.25 - 1);
    return {
      peak, mid, lin, toe,
      kA: peak * lin + peak * k,
      kB: -peak * k * Math.exp(lin / k),
      kC: -1 / (k * peak),
    };
  }

  // Readback goes through a pixel buffer and a fence, so it never stalls: each call starts a read and
  // returns the newest finished one, which is one frame behind.
  let pbo = null;
  let fence = null;
  let pending = null;
  let last = null;

  function collect() {
    if (!fence) return;
    const status = gl.clientWaitSync(fence, 0, 0);
    if (status !== gl.ALREADY_SIGNALED && status !== gl.CONDITION_SATISFIED) return;
    gl.deleteSync(fence);
    fence = null;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, pending.data);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    last = pending;
  }

  // mode 'pq' or 'srgb' (see litPq). Returns rows top first, as half floats when the driver can read them directly.
  function readHdr(lit, litU, mode) {
    collect();
    if (fence) return last;
    const curve = hdrCurve(1000);
    const pq = e.rt('litPq', e.screenW, e.screenH, 'rgba16f');
    e.draw('litPq', pq, lit, {
      uBloomScale: litU.uBloomScale,
      uExposure: litU.uExposure,
      uPeak: curve.peak,
      uMid: curve.mid,
      uLin: curve.lin,
      uToe: curve.toe,
      uKA: curve.kA,
      uKB: curve.kB,
      uKC: curve.kC,
      uOut: mode === 'srgb' ? 1 : 0,
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER, pq.fb);
    gl.getError();
    const half = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT) === gl.RGBA
      && gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE) === gl.HALF_FLOAT;
    const n = pq.w * pq.h * 4;
    const Type = half ? Uint16Array : Float32Array;
    const spare = [pending, last].find((b) => b && b !== last && b.data.length === n && b.data instanceof Type);
    pending = spare || { data: new Type(n), half, w: pq.w, h: pq.h };
    if (!pbo) pbo = gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, pending.data.byteLength, gl.STREAM_READ);
    gl.readPixels(0, 0, pq.w, pq.h, gl.RGBA, half ? gl.HALF_FLOAT : gl.FLOAT, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    if (gl.getError()) {
      e.hdrReadFailed = true;
      return null;
    }
    fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    return last;
  }

  function hdrPending() {
    return !!fence;
  }

  function dropHdr() {
    if (fence) gl.deleteSync(fence);
    if (pbo) gl.deleteBuffer(pbo);
    fence = pbo = pending = last = null;
  }

  Object.assign(e, { hdrCurve, readHdr, hdrPending, dropHdr });
}
