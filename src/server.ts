import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { crawl } from './crawler.js';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs-extra';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = 3000;

app.use(cors());
app.use(bodyParser.json());

// In-memory job store
const jobs: Record<string, { status: 'pending' | 'crawling' | 'completed' | 'failed', data?: any, error?: string }> = {};

app.post('/crawl', async (req, res) => {
    const { url } = req.body;
    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    const jobId = uuidv4();
    jobs[jobId] = { status: 'pending' };

    // Start crawling in background
    (async () => {
        try {
            jobs[jobId].status = 'crawling';
            const outputFile = path.join(__dirname, `../output/crawl-${jobId}.json`);
            const data = await crawl(url, outputFile);
            jobs[jobId].status = 'completed';
            jobs[jobId].data = data;
        } catch (error: any) {
            console.error(`Job ${jobId} failed:`, error);
            jobs[jobId].status = 'failed';
            jobs[jobId].error = error.message;
        }
    })();

    res.json({ jobId });
});

app.get('/status/:jobId', (req, res) => {
    const { jobId } = req.params;
    const job = jobs[jobId];

    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }

    res.json(job);
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT} (v2)`);
});
