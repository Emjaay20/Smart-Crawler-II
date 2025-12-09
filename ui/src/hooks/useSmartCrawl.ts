import { useState, useRef } from 'react';

export interface CrawlResult {
    status: 'completed' | 'failed' | 'pending' | 'crawling';
    data?: any;
    error?: string;
}

export const useSmartCrawl = () => {
    const [status, setStatus] = useState<'idle' | 'crawling' | 'success' | 'error' | 'timeout'>('idle');
    const [progress, setProgress] = useState(0);
    const [data, setData] = useState<any>(null);

    // Refs to manage intervals without causing re-renders
    const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const progressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const attempts = useRef(0);

    const MAX_ATTEMPTS = 30; // 60 seconds total

    const startJob = async (url: string) => {
        setStatus('crawling');
        setProgress(10);
        attempts.current = 0;

        // 1. Start the "Fake" Progress Bar
        if (progressTimer.current) clearInterval(progressTimer.current);
        progressTimer.current = setInterval(() => {
            setProgress((old) => {
                if (old >= 90) return 90; // Stall at 90%
                return old + Math.random() * 5; // Random increments
            });
        }, 1000);

        try {
            // 2. Dispatch Job
            const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';
            const res = await fetch(`${API_URL}/crawl`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url }),
            });
            const { jobId } = await res.json();

            // 3. Start Polling
            if (pollTimer.current) clearInterval(pollTimer.current);
            pollTimer.current = setInterval(async () => {
                attempts.current += 1;

                // A. TIMEOUT SAFETY
                if (attempts.current > MAX_ATTEMPTS) {
                    if (pollTimer.current) clearInterval(pollTimer.current);
                    if (progressTimer.current) clearInterval(progressTimer.current);
                    setStatus('timeout');
                    return;
                }

                // B. CHECK STATUS
                try {
                    const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';
                    const statusRes = await fetch(`${API_URL}/status/${jobId}`);
                    const result: CrawlResult = await statusRes.json();

                    if (result.status === 'completed') {
                        if (pollTimer.current) clearInterval(pollTimer.current);
                        if (progressTimer.current) clearInterval(progressTimer.current);
                        setProgress(100); // Jump to finish
                        setData(result.data);
                        setStatus('success');
                        // Trigger download automatically
                        downloadFile(result.data, `crawl-${jobId}.json`);
                    }
                    else if (result.status === 'failed') {
                        if (pollTimer.current) clearInterval(pollTimer.current);
                        if (progressTimer.current) clearInterval(progressTimer.current);
                        setStatus('error');
                        setProgress(0);
                    }
                } catch (e) {
                    console.error("Polling error", e);
                }
            }, 2000);

        } catch (err) {
            console.error(err);
            setStatus('error');
            if (progressTimer.current) clearInterval(progressTimer.current);
        }
    };

    const downloadFile = (json: any, name: string) => {
        const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = name;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    return { status, progress, startJob, data };
};
