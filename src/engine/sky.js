// light: [azimuth, elevation] in degrees. Azimuth 0 is behind the camera, 180 faces it.
// Elevation 0 is the horizon; negative is below it.
export function sunDirection(light) {
  const az = light[0] * Math.PI / 180;
  const el = light[1] * Math.PI / 180;
  return [Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)];
}

export function sunColor(dir) {
  const RE = 6371e3;
  const RA = 6471e3;
  const oy = RE + 2;
  const b = oy * dir[1];
  const under = b * b - (oy * oy - RE * RE);
  if (under >= 0 && -b - Math.sqrt(under) > 0) return [0, 0, 0];
  const t = -b + Math.sqrt(b * b - (oy * oy - RA * RA));
  const ds = t / 32;
  let odR = 0;
  let odM = 0;
  for (let i = 0; i < 32; i++) {
    const s = ds * (i + 0.5);
    const h = Math.hypot(dir[0] * s, oy + dir[1] * s, dir[2] * s) - RE;
    odR += Math.exp(-h / 8e3) * ds;
    odM += Math.exp(-h / 1.2e3) * ds;
  }
  return [5.5e-6, 13.0e-6, 22.4e-6].map((br) => 22 * Math.exp(-(br * odR + 21e-6 * odM)));
}

export function addSky(e) {
  const { gl } = e;

  function bakeSky(sun, sunRgb) {
    const env = {
      uEnv0: e.rt('env0', 512, 256, 'rgba16f'),
      uEnv1: e.rt('env1', 256, 128, 'rgba16f'),
      uEnv2: e.rt('env2', 128, 64, 'rgba16f'),
      uEnv3: e.rt('env3', 64, 32, 'rgba16f'),
      uEnv4: e.rt('env4', 32, 16, 'rgba16f'),
      uIrr: e.rt('envIrr', 32, 16, 'rgba16f'),
    };
    const key = sun.join();
    if (key === e.skyKey) return env;
    e.skyKey = key;
    e.draw('sky', env.uEnv0, {}, { uSun: sun, uSunColor: sunRgb });
    gl.bindTexture(gl.TEXTURE_2D, env.uEnv0.tex);
    gl.generateMipmap(gl.TEXTURE_2D);
    e.minFilter.set(env.uEnv0.tex, gl.LINEAR_MIPMAP_LINEAR);
    [env.uEnv1, env.uEnv2, env.uEnv3, env.uEnv4].forEach((out, i) => {
      e.draw('prefilter', out, { uEnv: env.uEnv0 }, { uEnvSize: [512, 256], uRough: (i + 1) / 4 });
    });
    e.draw('irradiance', env.uIrr, { uEnv: env.uEnv0 }, { uEnvSize: [512, 256] });
    if (env.uIrr.float) {
      const px = new Float32Array(4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, env.uIrr.fb);
      gl.readPixels(0, env.uIrr.h - 1, 1, 1, gl.RGBA, gl.FLOAT, px);
      e.skyUp = [px[0], px[1], px[2]];
    }
    return env;
  }

  // Half-resolution background. Kept while the sun and the framing stay the same.
  function renderSkyView(sun, sunRgb, repeat, zoom, center) {
    const view = e.rt('skyView', Math.ceil(e.screenW / 2), Math.ceil(e.screenH / 2), 'rgba16f');
    const key = [sun, sunRgb, e.screenW, e.screenH, e.width, e.height, repeat, zoom, center].join();
    if (key === e.skyViewKey && view.tex === e.skyViewTex) return view;
    e.skyViewKey = key;
    e.skyViewTex = view.tex;
    e.draw('skyView', view, {}, {
      uSun: sun,
      uSunColor: sunRgb,
      uRes: [e.width, e.height],
      uView: [e.screenW, e.screenH],
      uRepeatX: repeat[0],
      uRepeatY: repeat[1],
      uZoom: zoom,
      uCenter: center,
    });
    return view;
  }

  Object.assign(e, { bakeSky, renderSkyView });
}
