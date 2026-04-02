const express = require('express');
const cors = require('cors');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const app = express();

const PORT = Number(process.env.PORT || 3000);
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const SUPPORTED_PLATFORMS = ['youtube.com', 'youtu.be', 'tiktok.com', 'instagram.com', 'facebook.com', 'fb.watch'];

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

function ensureDownloadsDir() {
  if (!fs.existsSync(DOWNLOADS_DIR)) {
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  }
}

function isSupportedUrl(input) {
  try {
    const parsed = new URL(input);
    const host = parsed.hostname.toLowerCase();
    return SUPPORTED_PLATFORMS.some((platform) => host === platform || host.endsWith(`.${platform}`));
  } catch {
    return false;
  }
}

function createPublicUrl(req, fileName) {
  return `${req.protocol}://${req.get('host')}/files/${encodeURIComponent(fileName)}`;
}

function sanitizeFileName(name) {
  return path.basename(name).replace(/[\r\n]/g, '').trim();
}

function getCookiesArgs(cookiesFile) {
  if (!cookiesFile) return [];
  const resolved = path.resolve(cookiesFile);
  if (!fs.existsSync(resolved)) return [];
  return ['--cookies', resolved];
}

async function findDownloadedFile(prefix) {
  const entries = await fsp.readdir(DOWNLOADS_DIR, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isFile() && entry.name.startsWith(`${prefix}.`))
    .map((entry) => entry.name);

  if (candidates.length === 0) {
    return null;
  }

  if (candidates.length === 1) {
    return candidates[0];
  }

  const withStats = await Promise.all(
    candidates.map(async (name) => {
      const fullPath = path.join(DOWNLOADS_DIR, name);
      const stats = await fsp.stat(fullPath);
      return { name, mtimeMs: stats.mtimeMs };
    })
  );

  withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return withStats[0].name;
}

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('yt-dlp', args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      reject(new Error(`Failed to start yt-dlp: ${error.message}`));
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(stderr.trim() || stdout.trim() || `yt-dlp exited with code ${code}`));
      }
    });
  });
}

app.get('/health', (_req, res) => {
  res.json({ success: true, status: 'ok' });
});

app.use('/files', express.static(DOWNLOADS_DIR, {
  fallthrough: false,
  index: false,
  maxAge: '1d'
}));

app.get('/stream/:fileName', async (req, res) => {
  try {
    const fileName = sanitizeFileName(req.params.fileName);
    const filePath = path.join(DOWNLOADS_DIR, fileName);

    if (!filePath.startsWith(DOWNLOADS_DIR)) {
      return res.status(400).json({ success: false, error: 'Invalid file path.' });
    }

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, error: 'File not found.' });
    }

    const stat = await fsp.stat(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (!range) {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': 'application/octet-stream'
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    const parts = range.replace(/bytes=/, '').split('-');
    const start = Number(parts[0]);
    const end = parts[1] ? Number(parts[1]) : fileSize - 1;

    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || end >= fileSize) {
      return res.status(416).json({ success: false, error: 'Requested range not satisfiable.' });
    }

    const chunkSize = end - start + 1;
    const stream = fs.createReadStream(filePath, { start, end });

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': 'application/octet-stream'
    });

    stream.pipe(res);
  } catch (error) {
    console.error('Stream error:', error);
    res.status(500).json({ success: false, error: 'Unable to stream file.' });
  }
});

app.post('/download', async (req, res) => {
  try {
    ensureDownloadsDir();

    const { url, format = 'video', cookiesFile } = req.body || {};

    if (!url || typeof url !== 'string') {
      return res.status(400).json({ success: false, error: 'A valid URL is required.' });
    }

    if (!isSupportedUrl(url)) {
      return res.status(400).json({
        success: false,
        error: 'Unsupported platform. Supported: YouTube, TikTok, Instagram, Facebook.'
      });
    }

    const normalizedFormat = format === 'audio' ? 'audio' : 'video';
    const downloadId = crypto.randomBytes(12).toString('hex');
    const outputTemplate = path.join(DOWNLOADS_DIR, `${downloadId}.%(ext)s`);

    const args = [
      '--no-playlist',
      '--no-warnings',
      '--restrict-filenames',
      '-o',
      outputTemplate,
      ...getCookiesArgs(cookiesFile || process.env.YTDLP_COOKIES_FILE)
    ];

    if (normalizedFormat === 'audio') {
      args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
    } else {
      args.push('-f', 'bv*+ba/b', '--merge-output-format', 'mp4');
    }

    args.push(url);

    await runYtDlp(args);

    const fileName = await findDownloadedFile(downloadId);
    if (!fileName) {
      return res.status(500).json({ success: false, error: 'Download completed, but output file was not found.' });
    }

    const safeFileName = sanitizeFileName(fileName);
    const filePath = path.join(DOWNLOADS_DIR, safeFileName);
    const stats = await fsp.stat(filePath);
    const publicUrl = createPublicUrl(req, safeFileName);

    return res.json({
      success: true,
      url: publicUrl,
      format: normalizedFormat,
      fileName: safeFileName,
      fileSize: stats.size
    });
  } catch (error) {
    console.error('Download error:', error);

    const message = error.message || 'Unexpected download error.';
    const lower = message.toLowerCase();

    let friendlyError = message;
    let statusCode = 500;

    if (lower.includes('unsupported url')) {
      friendlyError = 'This URL is not supported by the downloader.';
      statusCode = 400;
    } else if (lower.includes('sign in') || lower.includes('cookies')) {
      friendlyError = 'This media requires authentication. Please provide a valid cookies file.';
      statusCode = 401;
    } else if (lower.includes('network') || lower.includes('timed out')) {
      friendlyError = 'Network error while fetching media. Please try again.';
      statusCode = 502;
    }

    return res.status(statusCode).json({ success: false, error: friendlyError });
  }
});

app.use((err, _req, res, _next) => {
  console.error('Unhandled server error:', err);
  res.status(500).json({ success: false, error: 'Internal server error.' });
});

ensureDownloadsDir();

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
