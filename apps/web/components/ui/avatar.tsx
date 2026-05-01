'use client';

import * as React from 'react';
import * as AvatarPrimitive from '@radix-ui/react-avatar';

import {
   markCachedAvatarImageFailed,
   type AvatarImageStatus,
   useCachedAvatarImage,
} from '@/lib/avatar-cache';
import { cn } from '@/lib/utils';

type AvatarContextValue = {
   imageVisible: boolean;
   setImageVisible: (visible: boolean) => void;
};

type AvatarImageProps = Omit<React.ComponentProps<'img'>, 'src'> & {
   onLoadingStatusChange?: (status: AvatarImageStatus) => void;
   src?: string | null;
};

const AvatarContext = React.createContext<AvatarContextValue | null>(null);

function Avatar({ className, ...props }: React.ComponentProps<typeof AvatarPrimitive.Root>) {
   const [imageVisible, setImageVisible] = React.useState(false);
   const setAvatarImageVisible = React.useCallback((visible: boolean) => {
      setImageVisible(visible);
   }, []);
   const contextValue = React.useMemo(
      () => ({ imageVisible, setImageVisible: setAvatarImageVisible }),
      [imageVisible, setAvatarImageVisible]
   );

   return (
      <AvatarContext.Provider value={contextValue}>
         <AvatarPrimitive.Root
            data-slot="avatar"
            className={cn('relative flex size-8 shrink-0 overflow-hidden rounded-full', className)}
            {...props}
         />
      </AvatarContext.Provider>
   );
}

function AvatarImage({
   className,
   onError,
   onLoadingStatusChange,
   src,
   ...props
}: AvatarImageProps) {
   const context = React.useContext(AvatarContext);
   const setImageVisible = context?.setImageVisible;
   const avatarImage = useCachedAvatarImage(src);

   React.useEffect(() => {
      setImageVisible?.(Boolean(avatarImage.src));
      onLoadingStatusChange?.(avatarImage.status);

      return () => {
         setImageVisible?.(false);
      };
   }, [avatarImage.src, avatarImage.status, setImageVisible, onLoadingStatusChange]);

   if (!avatarImage.src) return null;

   return (
      <img
         data-slot="avatar-image"
         className={cn('aspect-square size-full', className)}
         src={avatarImage.src}
         onError={(event) => {
            markCachedAvatarImageFailed(avatarImage.originalSrc);
            onError?.(event);
         }}
         {...props}
      />
   );
}

function AvatarFallback({
   className,
   ...props
}: React.ComponentProps<typeof AvatarPrimitive.Fallback>) {
   const context = React.useContext(AvatarContext);
   if (context?.imageVisible) return null;

   return (
      <AvatarPrimitive.Fallback
         data-slot="avatar-fallback"
         className={cn(
            'bg-muted flex size-full items-center justify-center rounded-full',
            className
         )}
         {...props}
      />
   );
}

export { Avatar, AvatarImage, AvatarFallback };
