import Redlock from 'redlock';
import Redis from 'ioredis';
import { getRedisURI } from '../../database/redis';

const getRedLock = () => {
  const redisUrl = getRedisURI();
  const redis = new Redis(redisUrl);
  return new Redlock([redis], {
    driftFactor: 0.01,
    retryCount: 10,
    retryDelay: 200,
    retryJitter: 200,
  });
}

const redlock = getRedLock();

export async function redOptLock (
  key: string,
  lockDurationMS = process.env.META_SYNC_LOCK_DURATION || 180000 // 3 minutes
): Promise<() => Promise<void>> {
  try {
    const lock = await redlock.lock(key, lockDurationMS);
    return async () => {
      if (lock && lock.expiration > Date.now() && lock.expiration !== 0) {
          console.log(`releasing lock for resource: ${key}`);
          await lock.unlock();
      }
    };
  } catch (e) {
    if (e.name === 'LockError') {
      console.log(`unable to acquire lock for resource: "${key}". Retrying...`);
      await new Promise(resolve => setTimeout(resolve, 1000));
      return redOptLock(key, lockDurationMS);
    }
    throw e;
  }
};