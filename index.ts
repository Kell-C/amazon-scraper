import express from 'express';
import axios from 'axios';
import { JSDOM } from 'jsdom';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import RecaptchaPlugin from 'puppeteer-extra-plugin-recaptcha';
import { executablePath } from 'puppeteer';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Enhanced anti-bot configuration
puppeteer.use(StealthPlugin());
puppeteer.use(
  RecaptchaPlugin({
    provider: {
      id: '2captcha',
      token: process.env.TWO_CAPTCHA_API_KEY
    },
    visualFeedback: true
  })
);

// CORS configuration
const corsOptions = {
  origin: [
    'https://kell-c.github.io',
    'http://localhost:5173',
    'http://localhost:5174',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:5174'
  ],
  methods: ['GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: true,
  optionsSuccessStatus: 204
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// Rate limiting middleware
const requestCounts = new Map();
app.use((req, res, next) => {
  const ip = req.ip;
  const currentCount = requestCounts.get(ip) || 0;
  
  if (currentCount > 10) {
    return res.status(429).json({ 
      error: 'Too many requests',
      solution: 'Please wait and try again later'
    });
  }
  
  requestCounts.set(ip, currentCount + 1);
  setTimeout(() => requestCounts.delete(ip), 60000);
  next();
});

// Puppeteer data cleanup
async function clearPuppeteerData() {
  const dir = path.join(__dirname, 'puppeteer_data');
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    console.error('Error cleaning puppeteer data:', error);
  }
}

// Improved browser instance management
let browserInstance;
const getBrowser = async () => {
  if (browserInstance) return browserInstance;
  
  await clearPuppeteerData();
  
  const launchOptions = {
    executablePath: executablePath(),
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      '--window-size=1920,1080',
      '--disable-blink-features=AutomationControlled'
    ],
    ignoreHTTPSErrors: true,
    timeout: 60000
  };

  if (process.env.PROXY_SERVER) {
    launchOptions.args.push(`--proxy-server=${process.env.PROXY_SERVER}`);
  }

  browserInstance = await puppeteer.launch(launchOptions);
  return browserInstance;
};

// Dynamic headers generator
const getAmazonHeaders = () => {
  const chromeVersion = Math.floor(Math.random() * 10) + 115;
  return {
    'authority': 'www.amazon.com',
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    'cache-control': 'max-age=0',
    'sec-ch-ua': `"Google Chrome";v="${chromeVersion}", "Chromium";v="${chromeVersion}", "Not=A?Brand";v="24"`,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'sec-fetch-user': '?1',
    'upgrade-insecure-requests': '1',
    'user-agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion}.0.0.0 Safari/537.36`
  };
};

// Improved scraping endpoint
app.get('/api/scrape', async (req, res) => {
  try {
    const { keyword, retry = 0 } = req.query;
    
    if (!keyword || typeof keyword !== 'string') {
      return res.status(400).json({ 
        error: 'Valid keyword parameter is required',
        example: '/api/scrape?keyword=laptop'
      });
    }

    const retryCount = Math.min(parseInt(retry) || 0, 3);
    let products = [];
    let lastError = null;

    for (let attempt = 0; attempt <= retryCount; attempt++) {
      try {
        if (attempt > 0) {
          const delay = 2000 * attempt;
          await new Promise(resolve => setTimeout(resolve, delay));
        }

        products = await scrapeWithPuppeteer(keyword);
        if (products.length > 0) break;

      } catch (error) {
        lastError = error;
        if (attempt === retryCount) {
          try {
            products = await scrapeWithAxios(keyword);
          } catch (axiosError) {
            lastError = axiosError;
          }
        }
      }
    }

    if (products.length === 0) {
      return res.status(404).json({ 
        error: 'No products found',
        details: lastError?.message || 'Try different keywords',
        solution: 'Amazon may be blocking requests - try again later'
      });
    }

    res.json({ 
      success: true, 
      count: products.length,
      products: products.filter(p => p.title && p.price)
    });
    
  } catch (error) {
    console.error('Scraping error:', error);
    res.status(500).json({
      error: 'Scraping failed',
      details: error.message.includes('CAPTCHA') 
        ? 'CAPTCHA detected' 
        : error.message,
      solution: 'Use proxies or try again later'
    });
  }
});

// Optimized Puppeteer scraper
async function scrapeWithPuppeteer(keyword) {
  let page;
  const browser = await getBrowser();

  try {
    page = await browser.newPage();
    
    // Configure page
    await page.setUserAgent(getAmazonHeaders()['user-agent']);
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setRequestInterception(true);
    
    page.on('request', req => {
      if (['image', 'font', 'stylesheet'].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    // Navigate to Amazon
    await page.goto(`https://www.amazon.com/s?k=${encodeURIComponent(keyword)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    // CAPTCHA handling
    if (await page.$('#captchacharacters')) {
      await page.solveRecaptchas();
      if (await page.$('#captchacharacters')) {
        throw new Error('CAPTCHA verification required');
      }
    }

    // Wait for results
    await page.waitForSelector('[data-asin]', { timeout: 10000 });

    // Extract product data
 return await page.evaluate(() => {
  return Array.from(document.querySelectorAll('[data-asin]'))
    .map(item => {
      const getText = (el) => el?.textContent?.trim();
      const getAttribute = (el, attr) => el?.getAttribute(attr);
      const asin = item.getAttribute('data-asin');
      const linkElement = item.querySelector('a[href*="/dp/"], a[href*="/gp/product/"]');
      
      return {
        title: getText(item.querySelector('h2 span')),
        price: getText(item.querySelector('.a-price span')),
        rating: getAttribute(item.querySelector('[aria-label*="stars"]'), 'aria-label'),
        imageUrl: getAttribute(item.querySelector('img.s-image'), 'src'),
        link: linkElement 
          ? `https://www.amazon.com${new URL(linkElement.href).pathname}`
          : `https://www.amazon.com/dp/${asin}`
      };
    })
    .filter(p => p.title && p.price);
});

// Fallback Axios scraper
async function scrapeWithAxios(keyword) {
  try {
    const { data } = await axios.get(`https://www.amazon.com/s?k=${encodeURIComponent(keyword)}`, {
      headers: getAmazonHeaders(),
      timeout: 15000
    });

    if (data.includes('robot-verification')) {
      throw new Error('CAPTCHA detected');
    }

    const dom = new JSDOM(data);
    return Array.from(dom.window.document.querySelectorAll('[data-asin]'))
      .map(item => ({
        title: item.querySelector('h2 span')?.textContent?.trim(),
        price: item.querySelector('.a-price span')?.textContent?.trim(),
        rating: item.querySelector('[aria-label*="stars"]')?.getAttribute('aria-label'),
        imageUrl: item.querySelector('img.s-image')?.src,
        link: item.querySelector('a[href*="/dp/"]')?.href
      }))
      .filter(p => p.title && p.price);

  } catch (error) {
    throw new Error(error.response?.status === 503 
      ? 'Amazon is blocking requests' 
      : error.message);
  }
}

// Server startup
(async () => {
  try {
    await clearPuppeteerData();
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });

    process.on('SIGTERM', async () => {
      if (browserInstance) await browserInstance.close();
      process.exit(0);
    });

  } catch (error) {
    console.error('Server startup failed:', error);
    process.exit(1);
  }
})();

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});
