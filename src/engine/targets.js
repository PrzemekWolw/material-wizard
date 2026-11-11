export function addTargets(e) {
  const { gl, floatOk, rts } = e;

  // [internal format, format, type, bytes per pixel]
  const FORMATS = {
    rgba8: [gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, 4],
    rgba16f: [gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, 8],
    r8: [gl.R8, gl.RED, gl.UNSIGNED_BYTE, 1],
    r16f: [gl.R16F, gl.RED, gl.HALF_FLOAT, 2],
  };

  function rt(name, w, h, format = 'rgba8') {
    if (!floatOk) format = format === 'r16f' ? 'r8' : format === 'rgba16f' ? 'rgba8' : format;
    const prev = rts.get(name);
    if (prev && prev.w === w && prev.h === h && prev.format === format) return prev;
    if (prev) {
      gl.deleteTexture(prev.tex);
      gl.deleteFramebuffer(prev.fb);
    }
    const [internal, layout, type] = FORMATS[format];
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, layout, type, null);
    if (gl.getError() === gl.OUT_OF_MEMORY || gl.isContextLost()) {
      gl.deleteTexture(tex);
      rts.delete(name);
      throw new Error('gpu-oom');
    }
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const made = { name, tex, fb, w, h, format, float: format.endsWith('16f'), gray: format.startsWith('r8') || format === 'r16f' };
    rts.set(name, made);
    return made;
  }

  function freeTarget(name) {
    const target = rts.get(name);
    if (!target) return;
    gl.deleteTexture(target.tex);
    gl.deleteFramebuffer(target.fb);
    rts.delete(name);
  }

  // Min filter per texture, for the few that are sampled with mipmaps. Everything else is linear.
  const minFilter = new WeakMap();
  const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
  const samplers = new Map();
  function samplerFor(tex) {
    const filter = minFilter.get(tex) || gl.LINEAR;
    const key = e.wrapS + ' ' + e.wrapT + ' ' + filter;
    let sampler = samplers.get(key);
    if (!sampler) {
      sampler = gl.createSampler();
      gl.samplerParameteri(sampler, gl.TEXTURE_MIN_FILTER, filter);
      gl.samplerParameteri(sampler, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.samplerParameteri(sampler, gl.TEXTURE_WRAP_S, e.wrapS);
      gl.samplerParameteri(sampler, gl.TEXTURE_WRAP_T, e.wrapT);
      if (aniso && filter !== gl.LINEAR) gl.samplerParameterf(sampler, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(16, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
      samplers.set(key, sampler);
    }
    return sampler;
  }

  const locations = new Map();
  function location(prog, key) {
    let table = locations.get(prog);
    if (!table) locations.set(prog, table = new Map());
    if (!table.has(key)) table.set(key, gl.getUniformLocation(prog, key));
    return table.get(key);
  }

  function draw(name, out, textures, uniforms) {
    const prog = e.program(name);
    gl.useProgram(prog);
    gl.bindFramebuffer(gl.FRAMEBUFFER, out ? out.fb : null);
    gl.viewport(0, 0, out ? out.w : e.screenW, out ? out.h : e.screenH);
    let unit = 0;
    for (const key in textures) {
      const tex = textures[key].tex || textures[key];
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.bindSampler(unit, samplerFor(tex));
      const loc = location(prog, key);
      if (loc) gl.uniform1i(loc, unit);
      unit += 1;
    }
    for (const key in uniforms) {
      const loc = location(prog, key);
      if (!loc) continue;
      const val = uniforms[key];
      if (typeof val === 'number') gl.uniform1f(loc, val);
      else if (val instanceof Float32Array) gl.uniform4fv(loc, val);
      else if (val.length === 2) gl.uniform2f(loc, val[0], val[1]);
      else if (val.length === 3) gl.uniform3f(loc, val[0], val[1], val[2]);
      else if (val.length === 9) gl.uniformMatrix3fv(loc, false, val);
      else gl.uniform4f(loc, val[0], val[1], val[2], val[3]);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function uploadImage(image) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    if (gl.getError() === gl.OUT_OF_MEMORY || gl.isContextLost()) {
      gl.deleteTexture(tex);
      throw new Error('gpu-oom');
    }
    return tex;
  }

  function readPixels(target) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
    const buf = new Uint8Array(target.w * target.h * 4);
    gl.readPixels(0, 0, target.w, target.h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    if (target.w * target.h > 1 << 20) freeTarget(target.name);
    return buf;
  }

  // RGBA bytes, rows top first. Single-channel targets come out as gray RGB.
  function read(target) {
    const out = rt('tmpB', target.w, target.h);
    draw('readout', out, { uTex: target }, { uGray: target.gray ? 1 : 0, uPack: 0 });
    return readPixels(out);
  }

  // One channel (R by default), rows top first, four pixels per texel. Row y starts at y * stride.
  function readGray(target, channel = 0) {
    const out = rt('tmpP', Math.ceil(target.w / 4), target.h);
    draw('readout', out, { uTex: target }, { uGray: 0, uPack: 1, uPick: [0, 1, 2, 3].map((i) => (i === channel ? 1 : 0)) });
    return { gray: readPixels(out), stride: out.w * 4 };
  }

  function readSmall(name, src, n) {
    const small = rt(name, n, n);
    draw('copy', small, { uTex: src }, { uFlip: 0, uGray: src.gray ? 1 : 0 });
    return read(small);
  }

  function meanOf(target) {
    const buf = readSmall('mean', target, 16);
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < buf.length; i += 4) { r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; n++; }
    return [r / n / 255, g / n / 255, b / n / 255];
  }

  function targetBytes() {
    let bytes = 0;
    rts.forEach((target) => { bytes += target.w * target.h * FORMATS[target.format][3]; });
    return bytes;
  }

  Object.assign(e, { rt, freeTarget, minFilter, draw, uploadImage, read, readGray, readSmall, meanOf, targetBytes });
}
