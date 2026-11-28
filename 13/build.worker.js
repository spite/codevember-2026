import { runJob } from "./build-job.js";

self.onmessage = ({ data }) => runJob(data, (message, transfer) => self.postMessage(message, transfer));
