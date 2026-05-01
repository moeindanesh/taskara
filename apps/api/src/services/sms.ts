import { config } from '../config';
import { HttpError } from './http';

interface KavenegarResponse {
  return?: {
    status?: number;
    message?: string;
  };
  entries?: Array<Record<string, unknown>>;
}

export async function sendOTPSms(to: string, otp: number): Promise<void> {
  if (isSmsDryRun()) {
    console.log('DEV OTP SMS:', { to, otp });
    return;
  }

  const response = await requestKavenegar('verify/lookup.json', {
    receptor: to,
    token: otp,
    template: 'otp-dastak'
  });

  console.log('SMS sent successfully:', {
    messageId: response.entries?.[0]?.messageid,
    status: response.entries?.[0]?.statustext,
    receptor: response.entries?.[0]?.receptor,
    message: response.entries?.[0]?.message
  });
}

export async function sendMessageSimple(
  receptor: string | string[],
  message: string,
  sender?: string,
  date?: number,
  type?: string,
  localid?: number[],
  hide?: number
): Promise<void> {
  const params: Record<string, string | number> = {
    receptor: receptorParam(receptor),
    message
  };

  if (sender) params.sender = sender;
  if (date) params.date = date;
  if (type) params.type = type;
  if (localid) params.localid = localid.join(',');
  if (hide) params.hide = hide;

  if (isSmsDryRun()) {
    console.log('DEV SIMPLE SMS:', params);
    return;
  }

  const response = await requestKavenegar('sms/send.json', params);
  console.log('SMS sent successfully:', { entries: response.entries });
}

export function sendMessageToAdmin(message: string): Promise<void> {
  return sendMessageSimple('09366032534', message);
}

function receptorParam(receptor: string | string[]): string {
  return Array.isArray(receptor) ? receptor.join(',') : receptor;
}

function isSmsDryRun(): boolean {
  return false
  return process.env.NODE_ENV !== 'production';
}

async function requestKavenegar(path: string, params: Record<string, string | number>): Promise<KavenegarResponse> {
  if (!config.SMS_KAVEH_KEY) {
    throw new HttpError(503, 'SMS_KAVEH_KEY is required to send SMS');
  }

  const query = Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
  const url = `https://api.kavenegar.com/v1/${encodeURIComponent(config.SMS_KAVEH_KEY)}/${path}?${query}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json'
      }
    });
  } catch (error) {
    console.error('Error sending SMS:', error);
    throw error;
  }

  const payload = await parseKavenegarResponse(response);
  if (response.ok && payload?.return?.status === 200) return payload;

  const message = payload?.return?.message || response.statusText || 'SMS sending failed';
  console.error('Failed to send SMS:', message);
  throw new Error(`SMS sending failed: ${message}`);
}

async function parseKavenegarResponse(response: Response): Promise<KavenegarResponse> {
  try {
    return (await response.json()) as KavenegarResponse;
  } catch {
    return {
      return: {
        status: response.status,
        message: await response.text().catch(() => response.statusText)
      }
    };
  }
}
