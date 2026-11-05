export interface AntiBotDetectionResult {
  detected: boolean;
  provider?: 'cloudflare' | 'datadome' | 'akamai' | 'aws_waf' | 'perimeterx' | 'generic';
  reason?: string;
}

export function detectAntiBotChallenge(res: Response, html = ''): AntiBotDetectionResult {
  const status = res.status;
  const headers = res.headers;

  const server = headers.get('server')?.toLowerCase() ?? '';
  const cfRay = headers.get('cf-ray');
  const cfChlBypass = headers.get('cf-chl-bypass');
  const cfMitigated = headers.get('cf-mitigated');
  const dataDome = headers.get('x-datadome') || headers.get('x-datadome-response');
  const akamai = headers.get('x-akamai-transformed');
  const awsWaf = headers.get('x-amzn-waf-action');
  const px = headers.get('x-px-challenge');

  const lowerHtml = html.toLowerCase();

  // Cloudflare Turnstile / Under Attack / Interstitial
  if (
    cfRay ||
    cfChlBypass ||
    cfMitigated ||
    server.includes('cloudflare') ||
    lowerHtml.includes('cloudflare ray id')
  ) {
    if (
      status === 403 ||
      status === 429 ||
      status === 503 ||
      lowerHtml.includes('<title>just a moment...</title>') ||
      lowerHtml.includes('attention required! | cloudflare') ||
      lowerHtml.includes('cf-browser-verification') ||
      lowerHtml.includes('challenge-platform/h/') ||
      lowerHtml.includes('turnstile.js')
    ) {
      return {
        detected: true,
        provider: 'cloudflare',
        reason: 'Cloudflare Turnstile or WAF challenge detected',
      };
    }
  }

  // DataDome
  if (dataDome || lowerHtml.includes('datadome captcha') || lowerHtml.includes('datadome.js')) {
    return {
      detected: true,
      provider: 'datadome',
      reason: 'DataDome bot protection challenge detected',
    };
  }

  // Akamai
  if (akamai && (status === 403 || status === 429)) {
    return {
      detected: true,
      provider: 'akamai',
      reason: 'Akamai Bot Manager interstitial detected',
    };
  }

  // AWS WAF
  if (awsWaf === 'block' || awsWaf === 'challenge') {
    return {
      detected: true,
      provider: 'aws_waf',
      reason: 'AWS WAF token challenge detected',
    };
  }

  // PerimeterX / HUMAN
  if (px || lowerHtml.includes('press & hold') && status === 403) {
    return {
      detected: true,
      provider: 'perimeterx',
      reason: 'PerimeterX / HUMAN bot defense challenge detected',
    };
  }

  // Generic CAPTCHA or blocking text on 403/429
  if (status === 403 || status === 429) {
    if (
      lowerHtml.includes('please verify you are a human') ||
      lowerHtml.includes('access denied') ||
      lowerHtml.includes('bot detection') ||
      lowerHtml.includes('security check')
    ) {
      return {
        detected: true,
        provider: 'generic',
        reason: `Access blocked by anti-bot interstitial (HTTP ${status})`,
      };
    }
  }

  return { detected: false };
}
