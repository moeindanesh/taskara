/// <reference types="vite/client" />

interface ImportMetaEnv {
   readonly VITE_TASKARA_API_URL?: string;
   readonly VITE_TASKARA_AVATAR_URL_TEMPLATE?: string;
   readonly VITE_TASKARA_EXAMPLE_REPOSITORY_URL?: string;
   readonly VITE_TASKARA_HELP_X_URL?: string;
   readonly VITE_TASKARA_HELP_THREADS_URL?: string;
   readonly VITE_TASKARA_HELP_LINKEDIN_URL?: string;
   readonly VITE_TASKARA_SUPPORT_URL?: string;
   readonly VITE_TASKARA_PRODUCT_URL?: string;
   readonly VITE_TASKARA_PORTFOLIO_URL?: string;
   readonly VITE_TASKARA_REPOSITORY_URL?: string;
}

interface Window {
   __TASKARA_CONFIG__?: {
      TASKARA_API_URL?: string;
      VITE_TASKARA_API_URL?: string;
   };
}
