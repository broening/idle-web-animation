/*!
 * face.js - pure decision logic for the camera avatar page (addons/obs/avatar.html).
 *
 * Nothing in this file touches a camera, a <video> element or MediaPipe.
 * avatar.html does all of that fallible, asynchronous work - opening the
 * camera, loading the model from a CDN, running detectForVideo - and on
 * every detected frame hands this file three plain numbers and an object.
 * Keeping the two apart means the rules in gates/PLAN.md ("Engine API (part
 * 3)") and gates/L3b-avatar.md ("Agreed behaviour") can be proven in Node,
 * the same way IdleObs.matchState next to this file is proven without a
 * browser in tools/test-addons.mjs.
 *
 * Three entry points do the actual thinking:
 *
 *   IdleFace.headAngles(matrix16)                a 4x4 matrix -> { yaw, pitch } degrees
 *   IdleFace.toPointer(yawDeg, pitchDeg, mirror)  degrees -> { x, y } in -1..1
 *   IdleFace.step(memory, observation, now, options)
 *       the one call avatar.html makes every detected frame. Hysteresis, the
 *       1 s face-lost fallback, the smile timer and the resulting mood all
 *       live here. It returns the next `memory` alongside the numbers to
 *       hand the player, so the caller never has to know what is inside it -
 *       an empty object the first time is the whole contract.
 *
 * `observation` is either `null` ("no face this frame") or
 * `{ yaw, pitch, blendshapes }`, where `blendshapes` is a plain object of
 * MediaPipe category name to score (0..1) - avatar.html builds that object
 * from `results.faceBlendshapes[0].categories`, this file never sees the
 * MediaPipe result shape at all.
 *
 * Chromium 103 is the floor here too, same as scene.js next to this file -
 * see AGENTS.md and tools/check-compat.py, which lists this file.
 */
(function (global) {
  'use strict';

  var DEG = 180 / Math.PI;

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function num(v, d) { return isNum(v) ? v : d; }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /* ------------------------------------------------------------------ *
   * Head pose from MediaPipe's facial transformation matrix.
   * ------------------------------------------------------------------ */

  /* MediaPipe hands back a Matrix { rows: 4, columns: 4, data: number[16] }
   * per detected face when outputFacialTransformationMatrixes is on. `data`
   * is column-major - the layout WebGL, three.js and every demo that feeds
   * this matrix straight into a Matrix4 rely on - so column k occupies
   * data[4k .. 4k+3] and the rotation submatrix sits in the first three
   * rows of the first three columns:
   *
   *   data[0] data[4] data[8]      r00 r01 r02
   *   data[1] data[5] data[9]   =  r10 r11 r12
   *   data[2] data[6] data[10]     r20 r21 r22
   *
   * Yaw and pitch come out of that submatrix with the YXZ Euler
   * decomposition (yaw about Y first, then pitch about X, then roll about
   * Z - the same order three.js's Euler#setFromRotationMatrix uses for
   * 'YXZ', and the order face-tracking rigs reach for because it keeps yaw
   * and pitch readable independently of roll). In this layout:
   *
   *   pitch = asin(-r12)            r12 = data[9]
   *   yaw   = atan2(r02, r22)       r02 = data[8], r22 = data[10]
   *
   * with the usual gimbal fallback (read yaw from the other column) when
   * the face is pitched almost straight up or down and r02/r22 stop being
   * a reliable atan2 pair.
   *
   * What is NOT verified: whether MediaPipe's own axes agree with this in
   * the physical sense - whether a real head turning right on a real
   * webcam actually produces a positive yaw here. The formula is
   * internally consistent (a synthetic rotation matrix built for a chosen
   * angle comes back as that angle - see tools/test-addons.mjs), but nobody
   * has pointed a real camera at this yet. ?mirror=0 on avatar.html exists
   * for exactly that: flip toPointer()'s X sign from the page's own URL
   * without editing this file. */
  function headAngles(matrix16) {
    var d = matrix16 || [];
    function at(i, fallback) { return isNum(d[i]) ? d[i] : fallback; }

    var r12 = clamp(at(9, 0), -1, 1);
    var pitch = Math.asin(-r12);

    var yaw;
    if (Math.abs(r12) < 0.9999999) {
      yaw = Math.atan2(at(8, 0), at(10, 1));
    } else {
      /* Looking almost straight up or down: r02/r22 degenerate together, so
       * yaw is read off the other column instead - the same fallback
       * three.js takes for this Euler order. */
      yaw = Math.atan2(-at(2, 0), at(0, 1));
    }

    return { yaw: yaw * DEG, pitch: pitch * DEG };
  }

  /* ------------------------------------------------------------------ *
   * Degrees to the -1..1 the engine's gaze and parallax already expect.
   * ------------------------------------------------------------------ */

  /* 25 degrees of head turn is "full deflection", the number the brief
   * settled on. Past that the value clamps rather than runs past 1, the
   * same reason gaze() itself clamps in player/idle.js: a figure cut from a
   * flat picture has nothing painted behind a part that moves further than
   * its rig was built for. */
  var FULL_DEFLECTION_DEG = 25;

  /* mirror true - the default avatar.html uses unless it is opened with
   * ?mirror=0 - flips X so the figure turns the same way the camera preview
   * does, the brief's "like a mirror". Y (pitch) is never flipped: nodding
   * up or down is not a left/right question, so there is nothing to mirror. */
  function toPointer(yawDeg, pitchDeg, mirror) {
    var x = clamp(num(yawDeg, 0) / FULL_DEFLECTION_DEG, -1, 1);
    var y = clamp(num(pitchDeg, 0) / FULL_DEFLECTION_DEG, -1, 1);
    if (mirror !== false) x = -x;
    return { x: x, y: y };
  }

  /* ------------------------------------------------------------------ *
   * Frame-rate independent smoothing.
   * ------------------------------------------------------------------ */

  /* An exponential filter with a time constant, not a fixed-per-frame lerp:
   * a fixed factor like `prev + (target - prev) * 0.2` covers a different
   * distance after the same wall-clock gap on a 30 Hz camera than on a
   * 60 Hz one. This closes to within 1/e of the target every `tau` seconds
   * no matter how choppy detectForVideo's own frame rate runs - including
   * the one very long `dt` a backgrounded OBS tab hands it after coming
   * back, which this still resolves to a finite, converged number instead
   * of overshooting or blowing up. */
  function smooth(prev, target, dt, tau) {
    var p = num(prev, num(target, 0));
    var tg = num(target, 0);
    var d = num(dt, 0);
    var t = (isNum(tau) && tau > 1e-6) ? tau : 0.12;
    if (d <= 0) return p;
    var k = 1 - Math.exp(-d / t);
    return p + (tg - p) * k;
  }

  /* ------------------------------------------------------------------ *
   * step(): everything avatar.html needs decided, once per detected frame.
   * ------------------------------------------------------------------ */

  function bsAt(bs, name) {
    var v = bs && bs[name];
    return isNum(v) ? v : 0;
  }

  /* Hysteresis pairs and hold times, straight out of gates/L3b-avatar.md -
   * change the behaviour here, once, rather than at every call site. */
  var BLINK_CLOSE = 0.55;
  var BLINK_OPEN = 0.45;
  var MOUTH_OPEN_ON = 0.35;
  var MOUTH_OPEN_OFF = 0.25;
  var SMILE_ON = 0.5;
  var FACE_LOST_SECONDS = 1.0;
  var SMILE_HOLD_SECONDS = 0.5;
  var SMILE_RELEASE_SECONDS = 1.5;
  var DEFAULT_TAU = 0.12;

  /* `memory` is opaque to the caller - avatar.html round-trips whatever
   * this returns as `memory` back in as the next call's first argument,
   * and passes {} the very first time. Nothing outside this file reads or
   * writes a field of it directly, so the shape below can change without
   * touching avatar.html. */
  function step(memory, observation, now, options) {
    var mem = (memory && typeof memory === 'object') ? memory : {};
    var opt = options || {};
    var mirror = opt.mirror !== false;
    var hasHappy = !!opt.hasHappy;
    var tau = num(opt.tau, DEFAULT_TAU);
    var t = num(now, 0);

    /* First call ever: no previous timestamp to measure a gap against, so
     * nothing has "elapsed" yet rather than one huge or negative dt. */
    var dt = isNum(mem._lastT) ? Math.max(0, t - mem._lastT) : 0;
    mem._lastT = t;

    if (observation) mem.lastSeenAt = t;
    /* No `lastSeenAt` at all - a face has never once been seen - reads as
     * an infinitely long absence, which is exactly right: a page that never
     * gets a camera should show the figure's own idle schedule from the
     * first frame, not wait a fake second for permission to say so. */
    var since = isNum(mem.lastSeenAt) ? (t - mem.lastSeenAt) : Infinity;
    var lost = since > FACE_LOST_SECONDS;

    /* ---- pointer: always smoothed. The observation only ever changes the
     * target the smoothing is chasing. ---- */
    var targetX = 0, targetY = 0;
    if (observation) {
      var p = toPointer(observation.yaw, observation.pitch, mirror);
      targetX = p.x; targetY = p.y;
    } else if (!lost) {
      /* Within the first second of a lost face, keep heading where the
       * face was last pointing rather than snapping to centre - a dropped
       * frame or two of detection must not read as a flinch back to
       * looking straight ahead. */
      targetX = num(mem.targetX, 0);
      targetY = num(mem.targetY, 0);
    }
    /* Past one second lost, targetX/targetY simply stay at the 0 they were
     * declared with above, and the smoothing below eases the pointer back
     * there over the next several frames - "eases", not a snap to centre. */
    mem.targetX = targetX;
    mem.targetY = targetY;
    mem.pointerX = smooth(mem.pointerX, targetX, dt, tau);
    mem.pointerY = smooth(mem.pointerY, targetY, dt, tau);

    /* ---- blink: BOTH eyes have to be closed. Hysteresis on the lesser of
     * the two scores does that in one comparison: the minimum only clears
     * the close threshold once neither eye is still open, and a single
     * flaky landmark on one eye cannot flutter the lids by itself. ---- */
    var blink;
    if (observation) {
      var closedness = Math.min(bsAt(observation.blendshapes, 'eyeBlinkLeft'),
                                 bsAt(observation.blendshapes, 'eyeBlinkRight'));
      if (mem.eyesClosed) {
        if (closedness < BLINK_OPEN) mem.eyesClosed = false;
      } else {
        if (closedness > BLINK_CLOSE) mem.eyesClosed = true;
      }
      blink = mem.eyesClosed ? 1 : 0;
    } else if (!lost) {
      blink = mem.eyesClosed ? 1 : 0;             /* hold the last reading */
    } else {
      mem.eyesClosed = false;
      blink = undefined;                          /* hand the schedule back */
    }

    /* ---- mouth: same hysteresis shape as blink, but with no schedule to
     * fall back to - "not given" is simply closed, same as ctx.mouth in
     * player/idle.js treats it. ---- */
    var mouth;
    if (observation) {
      var jaw = bsAt(observation.blendshapes, 'jawOpen');
      if (mem.mouthOpen) {
        if (jaw < MOUTH_OPEN_OFF) mem.mouthOpen = false;
      } else {
        if (jaw > MOUTH_OPEN_ON) mem.mouthOpen = true;
      }
      mouth = mem.mouthOpen ? 1 : 0;
    } else if (!lost) {
      mouth = mem.mouthOpen ? 1 : 0;
    } else {
      mem.mouthOpen = false;
      mouth = 0;
    }

    /* ---- mood: the scene (or ?state=) sets the base every call, so a
     * scene change lands immediately even while a smile currently overrides
     * it - "the smile still wins until it ends" falls out of moodIsHappy
     * being a separate flag from baseMood, not a reason to delay the
     * update. A held smile lifts the mood to "happy" for as long as it
     * lasts, plus a short release so a smile that flickers off for a single
     * frame does not visibly drop the mood and pick it straight back up. */
    if (typeof opt.baseMood === 'string' && opt.baseMood) mem.baseMood = opt.baseMood;
    if (typeof mem.baseMood !== 'string' || !mem.baseMood) mem.baseMood = 'neutral';

    var smiling = false;
    if (observation) {
      var mean = (bsAt(observation.blendshapes, 'mouthSmileLeft') +
                  bsAt(observation.blendshapes, 'mouthSmileRight')) / 2;
      smiling = mean > SMILE_ON;
    }

    if (smiling) {
      if (!mem.smiling) mem.smileSince = t;        /* a fresh smile starts the clock */
      mem.smiling = true;
      if (hasHappy && (t - num(mem.smileSince, t)) >= SMILE_HOLD_SECONDS) {
        mem.moodIsHappy = true;
      }
    } else {
      if (mem.smiling) mem.smileGoneAt = t;         /* a fresh non-smile starts the other clock */
      mem.smiling = false;
      if (mem.moodIsHappy && (t - num(mem.smileGoneAt, t)) >= SMILE_RELEASE_SECONDS) {
        mem.moodIsHappy = false;
      }
    }
    /* A figure that has no "happy" mood at all never switches, however long
     * the smile - checked every call, not just when a smile starts, so a
     * mood removed from figure.json mid-session (the studio again) lets go
     * immediately rather than waiting for the smile to end. */
    if (!hasHappy) mem.moodIsHappy = false;

    return {
      memory: mem,
      pointerX: mem.pointerX,
      pointerY: mem.pointerY,
      blink: blink,
      mouth: mouth,
      mood: mem.moodIsHappy ? 'happy' : mem.baseMood
    };
  }

  var api = {
    headAngles: headAngles,
    toPointer: toPointer,
    smooth: smooth,
    step: step
  };

  global.IdleFace = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

})(typeof window !== 'undefined' ? window : globalThis);
