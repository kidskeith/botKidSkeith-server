import { Request, Response, NextFunction } from 'express';
import jwt, { SignOptions } from 'jsonwebtoken';
import { config } from '../config/index.js';
import prisma from '../config/database.js';

export interface AuthRequest extends Request {
  userId?: string;
  user?: {
    id: string;
    email: string;
  };
}

export interface JWTPayload {
  userId: string;
  email: string;
}

/**
 * Middleware to verify JWT token
 */
export async function authenticate(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'No token provided' });
      return;
    }
    
    const token = authHeader.substring(7);
    
    // Verify JWT
    const payload = jwt.verify(token, config.jwtSecret) as JWTPayload;
    
    // Optionally verify session in database
    const session = await prisma.session.findFirst({
      where: {
        userId: payload.userId,
        expiresAt: { gt: new Date() },
      },
    });
    
    if (!session) {
      res.status(401).json({ error: 'Session expired' });
      return;
    }
    
    // Attach user info to request
    req.userId = payload.userId;
    req.user = {
      id: payload.userId,
      email: payload.email,
    };
    
    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      res.status(401).json({ error: 'Token expired' });
      return;
    }
    if (error instanceof jwt.JsonWebTokenError) {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }
    console.error('Auth error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
}

/**
 * Generate JWT token
 */
export function generateToken(payload: JWTPayload): string {
  return jwt.sign(payload, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
  } as SignOptions);
}

/**
 * Optional auth - doesn't fail if no token
 */
export async function optionalAuth(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    next();
    return;
  }
  
  try {
    const token = authHeader.substring(7);
    const payload = jwt.verify(token, config.jwtSecret) as JWTPayload;
    
    req.userId = payload.userId;
    req.user = {
      id: payload.userId, 
      email: payload.email,
    };
  } catch {
    // Ignore auth errors for optional auth
  }
  
  next();
}
