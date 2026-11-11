import { JOBS } from '../jobs.js';

const pending = new Map();

const channels = new Map();

let nextId = 1;

let worker = null;

let ready = null;

function inline(job) {
  setTimeout(() => {
    if (!pending.has(job.id)) return;
    Promise.resolve()
      .then(() => JOBS[job.type](job.payload))
      .then((result) => finish(job.id, result, null), (error) => finish(job.id, null, String(error && error.message || error)));
  }, 0);
}

function finish(id, result, error) {
  const job = pending.get(id);
  if (!job) return;
  pending.delete(id);
  if (job.channel && channels.get(job.channel) === id) channels.delete(job.channel);
  if (error) job.reject(new Error(error));
  else job.resolve(result);
}

function useInline(reason) {
  if (!worker) return;
  console.warn('worker unavailable, running jobs inline', reason);
  worker.terminate();
  worker = null;
}

if (typeof Worker !== 'undefined') {
  try {
    worker = new Worker(new URL('../work.worker.js', import.meta.url), { type: 'module' });
    ready = new Promise((resolve) => {
      worker.onmessage = (event) => {
        if (event.data.ready) { resolve(true); return; }
        finish(event.data.id, event.data.result, event.data.error);
      };
      worker.onerror = (event) => {
        useInline(event.message);
        pending.forEach((job, id) => finish(id, null, 'worker failed'));
        resolve(false);
      };
    });
  } catch (error) {
    worker = null;
    console.warn('worker unavailable, running jobs inline', error);
  }
}

// Runs a job from src/jobs.js. `transfer` lists buffers the caller gives up. A newer job on the same
// channel cancels the older one, whose promise rejects with "cancelled".
export function run(type, payload, { transfer = [], channel = '' } = {}) {
  const id = nextId++;
  if (channel && channels.has(channel)) cancel(channels.get(channel));
  if (channel) channels.set(channel, id);
  return new Promise((resolve, reject) => {
    const job = { id, type, payload, channel, resolve, reject };
    pending.set(id, job);
    if (!worker) { inline(job); return; }
    ready.then((ok) => {
      if (!pending.has(id)) return;
      if (!ok || !worker) { inline(job); return; }
      try { worker.postMessage({ id, type, payload }, transfer); }
      catch (error) { finish(id, null, String(error.message || error)); }
    });
  });
}

function cancel(id) {
  const job = pending.get(id);
  if (!job) return;
  if (worker) worker.postMessage({ cancel: id });
  finish(id, null, 'cancelled');
}

export function cancelled(error) {
  return error && error.message === 'cancelled';
}
