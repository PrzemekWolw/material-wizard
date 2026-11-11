import { JOBS, buffersOf } from './jobs.js';

const queue = [];

let draining = false;

// Jobs start from a timer, so cancel messages that arrive meanwhile can remove queued jobs.
function drain() {
  draining = false;
  const job = queue.shift();
  if (!job) return;
  Promise.resolve()
    .then(() => JOBS[job.type](job.payload))
    .then((result) => self.postMessage({ id: job.id, result }, buffersOf(result)))
    .catch((error) => self.postMessage({ id: job.id, error: String(error && error.message || error) }))
    .finally(next);
}

function next() {
  if (draining || !queue.length) return;
  draining = true;
  setTimeout(drain, 0);
}

self.onmessage = (event) => {
  const message = event.data;
  if (message.cancel) {
    const i = queue.findIndex((job) => job.id === message.cancel);
    if (i >= 0) queue.splice(i, 1);
    return;
  }
  queue.push(message);
  next();
};

self.postMessage({ ready: true });
