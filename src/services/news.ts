import axios from 'axios';

// CryptoCompare News API (free, no key required for basic usage)
const CRYPTO_NEWS_API = 'https://min-api.cryptocompare.com/data/v2/news/';

// Mapping of common coin symbols to search terms
const COIN_SEARCH_TERMS: Record<string, string[]> = {
  btc: ['bitcoin', 'BTC'],
  eth: ['ethereum', 'ETH'],
  xrp: ['ripple', 'XRP'],
  sol: ['solana', 'SOL'],
  doge: ['dogecoin', 'DOGE'],
  ada: ['cardano', 'ADA'],
  bnb: ['binance coin', 'BNB'],
  dot: ['polkadot', 'DOT'],
  avax: ['avalanche', 'AVAX'],
  link: ['chainlink', 'LINK'],
  ltc: ['litecoin', 'LTC'],
  matic: ['polygon', 'MATIC'],
};

interface NewsItem {
  title: string;
  body: string;
  source: string;
  url: string;
  published_on: number;
  categories: string;
}

interface NewsResponse {
  Data: NewsItem[];
}

/**
 * Fetch latest crypto news for a specific coin
 * @param pair - Trading pair like "xrp_idr" or "btc_idr"
 * @param limit - Number of news items to fetch (default: 5)
 * @returns Formatted news context string for AI
 */
export async function fetchCryptoNews(pair: string, limit: number = 5): Promise<string> {
  try {
    // Extract coin symbol from pair (e.g., "xrp_idr" -> "xrp")
    const coin = pair.toLowerCase().split('_')[0];
    const searchTerms = COIN_SEARCH_TERMS[coin] || [coin.toUpperCase()];
    
    // Fetch general crypto news
    const response = await axios.get<NewsResponse>(CRYPTO_NEWS_API, {
      params: {
        categories: coin.toUpperCase(),
        excludeCategories: 'Sponsored',
        lang: 'EN',
      },
      timeout: 5000,
    });
    
    const news = response.data?.Data || [];
    
    if (news.length === 0) {
      console.log(`[News] No news found for ${coin}`);
      return '';
    }
    
    // Filter news related to the coin and take top items
    const relevantNews = news
      .filter((item) => {
        const text = `${item.title} ${item.body}`.toLowerCase();
        return searchTerms.some(term => text.includes(term.toLowerCase()));
      })
      .slice(0, limit);
    
    if (relevantNews.length === 0) {
      // If no specific news, take general top news
      const topNews = news.slice(0, limit);
      return formatNewsContext(topNews, coin);
    }
    
    return formatNewsContext(relevantNews, coin);
  } catch (error: any) {
    console.error('[News] Failed to fetch news:', error.message);
    return ''; // Return empty string on error, AI will work without news
  }
}

/**
 * Format news items into a context string for AI
 */
function formatNewsContext(news: NewsItem[], coin: string): string {
  if (news.length === 0) return '';
  
  const formattedNews = news.map((item, index) => {
    const date = new Date(item.published_on * 1000).toLocaleDateString('id-ID');
    const summary = item.body.length > 200 
      ? item.body.substring(0, 200) + '...' 
      : item.body;
    
    return `${index + 1}. **${item.title}** (${date})
   ${summary}
   _Source: ${item.source}_`;
  }).join('\n\n');
  
  return `### Berita Terbaru ${coin.toUpperCase()}:\n\n${formattedNews}`;
}

/**
 * Quick sentiment check from news titles
 */
export function analyzeNewsSentiment(newsContext: string): 'positive' | 'negative' | 'neutral' {
  if (!newsContext) return 'neutral';
  
  const lowerNews = newsContext.toLowerCase();
  
  const positiveWords = ['surge', 'rally', 'bullish', 'gains', 'rises', 'jumps', 'soars', 'breakout', 'adoption', 'partnership'];
  const negativeWords = ['crash', 'plunge', 'bearish', 'falls', 'drops', 'slump', 'hack', 'scam', 'regulation', 'ban', 'lawsuit'];
  
  let positiveCount = 0;
  let negativeCount = 0;
  
  positiveWords.forEach(word => {
    if (lowerNews.includes(word)) positiveCount++;
  });
  
  negativeWords.forEach(word => {
    if (lowerNews.includes(word)) negativeCount++;
  });
  
  if (positiveCount > negativeCount) return 'positive';
  if (negativeCount > positiveCount) return 'negative';
  return 'neutral';
}
