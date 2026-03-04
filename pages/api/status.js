import { jobs } from '../../src/lib/jobStore.js';

export default function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { jobId } = req.query;
  if (!jobId) {
    return res.status(400).json({ error: 'jobId is required' });
  }

  const job = jobs.get(jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  return res.status(200).json({
    status: job.status,
    progress: job.progress,
    message: job.message,
    currentPage: job.currentPage,
    totalPages: job.totalPages,
    filename: job.filename,
    fileSize: job.fileSize,
    elapsedTime: job.elapsedTime,
  });
}
