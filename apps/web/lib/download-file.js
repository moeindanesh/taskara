import { taskaraApiBaseUrl, taskaraRequestHeaders } from '@/lib/taskara-client';

export async function downloadTaskaraFile(path, fallbackFilename) {
   const apiBaseUrl = taskaraApiBaseUrl();
   const response = await fetch(`${apiBaseUrl}${path}`, {
      headers: taskaraRequestHeaders(),
      cache: 'no-store',
   });

   if (!response.ok) {
      const message = await errorMessage(response);
      throw new Error(message || response.statusText || 'Download failed');
   }

   const blob = await response.blob();
   const filename = filenameFromDisposition(response.headers.get('content-disposition')) || fallbackFilename;
   const url = window.URL.createObjectURL(blob);
   const link = document.createElement('a');
   link.href = url;
   link.download = filename;
   document.body.appendChild(link);
   link.click();
   link.remove();
   window.URL.revokeObjectURL(url);
}

async function errorMessage(response) {
   const text = await response.text();
   if (!text) return '';

   try {
      const data = JSON.parse(text);
      return typeof data.message === 'string' ? data.message : text;
   } catch {
      return text;
   }
}

function filenameFromDisposition(disposition) {
   const match = disposition?.match(/filename="?([^"]+)"?/i);
   return match?.[1];
}
