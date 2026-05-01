import { useEffect, useMemo, useState } from 'react';

export type AvatarImageStatus = 'idle' | 'loading' | 'loaded' | 'error';

type AvatarImageCacheEntry = {
   image?: HTMLImageElement;
   listeners: Set<() => void>;
   promise?: Promise<void>;
   status: Exclude<AvatarImageStatus, 'idle'>;
};

const avatarImageCache = new Map<string, AvatarImageCacheEntry>();

function normalizeAvatarSrc(src: string | null | undefined) {
   const normalized = src?.trim();
   return normalized ? normalized : null;
}

function ensureAvatarImageEntry(src: string) {
   let entry = avatarImageCache.get(src);

   if (!entry) {
      entry = {
         listeners: new Set(),
         status: 'loading',
      };
      avatarImageCache.set(src, entry);
   }

   return entry;
}

function notifyAvatarImageListeners(entry: AvatarImageCacheEntry) {
   for (const listener of entry.listeners) {
      listener();
   }
}

export function getCachedAvatarImageStatus(src: string | null | undefined): AvatarImageStatus {
   const normalizedSrc = normalizeAvatarSrc(src);
   if (!normalizedSrc) return 'idle';

   return avatarImageCache.get(normalizedSrc)?.status || 'idle';
}

export function preloadCachedAvatarImage(src: string | null | undefined) {
   const normalizedSrc = normalizeAvatarSrc(src);
   if (!normalizedSrc) return Promise.resolve();

   const entry = ensureAvatarImageEntry(normalizedSrc);

   if (entry.status === 'loaded' || entry.status === 'error') {
      return Promise.resolve();
   }

   if (entry.promise) {
      return entry.promise;
   }

   if (typeof Image === 'undefined') {
      entry.status = 'loaded';
      notifyAvatarImageListeners(entry);
      return Promise.resolve();
   }

   entry.promise = new Promise<void>((resolve) => {
      const image = new Image();

      const finish = (status: Exclude<AvatarImageStatus, 'idle'>) => {
         entry.status = status;
         image.onload = null;
         image.onerror = null;
         notifyAvatarImageListeners(entry);
         resolve();
      };

      image.decoding = 'async';
      image.onload = () => finish('loaded');
      image.onerror = () => finish('error');
      image.src = normalizedSrc;
      entry.image = image;

      if (image.complete) {
         finish(image.naturalWidth > 0 ? 'loaded' : 'error');
      }
   });

   return entry.promise;
}

export function subscribeCachedAvatarImage(src: string | null | undefined, listener: () => void) {
   const normalizedSrc = normalizeAvatarSrc(src);
   if (!normalizedSrc) return () => {};

   const entry = ensureAvatarImageEntry(normalizedSrc);
   entry.listeners.add(listener);

   return () => {
      entry.listeners.delete(listener);
   };
}

export function markCachedAvatarImageFailed(src: string | null | undefined) {
   const normalizedSrc = normalizeAvatarSrc(src);
   if (!normalizedSrc) return;

   const entry = ensureAvatarImageEntry(normalizedSrc);
   entry.status = 'error';
   notifyAvatarImageListeners(entry);
}

export function useCachedAvatarImage(src: string | null | undefined) {
   const normalizedSrc = useMemo(() => normalizeAvatarSrc(src), [src]);
   const [status, setStatus] = useState<AvatarImageStatus>(() => getCachedAvatarImageStatus(normalizedSrc));

   useEffect(() => {
      if (!normalizedSrc) {
         setStatus('idle');
         return;
      }

      let isMounted = true;
      const syncStatus = () => {
         if (isMounted) {
            setStatus(getCachedAvatarImageStatus(normalizedSrc));
         }
      };

      syncStatus();
      const unsubscribe = subscribeCachedAvatarImage(normalizedSrc, syncStatus);
      void preloadCachedAvatarImage(normalizedSrc);
      syncStatus();

      return () => {
         isMounted = false;
         unsubscribe();
      };
   }, [normalizedSrc]);

   return {
      originalSrc: normalizedSrc,
      src: status === 'loaded' ? normalizedSrc : undefined,
      status,
   };
}
