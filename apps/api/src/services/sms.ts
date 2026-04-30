import { config } from '../config';
import { HttpError } from './http';

export const SMS_TEMPLATE_DEFINITIONS = {
  'no-plan': {
    templateName: 'no-plan',
    systemTemplateName: config.SMS_TEMPLATE_NO_PLAN ?? 'no-plan'
  },
  'today-reminder': {
    templateName: 'today-reminder',
    systemTemplateName: config.SMS_TEMPLATE_TODAY_REMINDER ?? 'today-reminder'
  },
  'task-created': {
    templateName: 'task-created',
    systemTemplateName: config.SMS_TEMPLATE_TASK_CREATED ?? 'task-created'
  }
} as const;

export type SmsTemplateName = keyof typeof SMS_TEMPLATE_DEFINITIONS;
export type SmsSystemTemplateName = (typeof SMS_TEMPLATE_DEFINITIONS)[SmsTemplateName]['systemTemplateName'];

export interface SendTemplateSmsInput {
  receptor: string | string[];
  template: SmsTemplateName;
  token?: string | number;
  token2?: string | number;
  token3?: string | number;
  token10?: string | number;
  token20?: string | number;
}

interface KavenegarResponse {
  return?: {
    status?: number;
    message?: string;
  };
  entries?: Array<Record<string, unknown>>;
}

export async function sendTemplateSms(input: SendTemplateSmsInput): Promise<void> {
  const { receptor, template, token, token2, token3, token10, token20 } = input;
  const systemTemplateName = SMS_TEMPLATE_DEFINITIONS[template].systemTemplateName;
  const params: Record<string, string | number> = {
    receptor: receptorParam(receptor),
    template: systemTemplateName
  };

  addLookupParam(params, 'token', token);
  addLookupParam(params, 'token2', token2);
  addLookupParam(params, 'token3', token3);
  addLookupParam(params, 'token10', token10);
  addLookupParam(params, 'token20', token20);

  if (isSmsDryRun()) {
    console.log('DEV TEMPLATE SMS:', { ...params, template: systemTemplateName });
    return;
  }

  const response = await requestKavenegar('verify/lookup.json', params);
  console.log('SMS sent successfully:', {
    entries: response.entries,
    template: systemTemplateName
  });
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

function addLookupParam(
  params: Record<string, string | number>,
  key: 'token' | 'token2' | 'token3' | 'token10' | 'token20',
  value: string | number | undefined
): void {
  if (value === undefined) return;

  if (key === 'token10') {
    params[key] = toLookupTextToken(value, 5);
    return;
  }

  if (key === 'token20') {
    params[key] = toLookupTextToken(value, 8);
    return;
  }

  params[key] = toLookupCodeToken(value);
}

function toLookupCodeToken(value: string | number): string {
  const token = String(value)
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]/gu, '-')
    .slice(0, 100);

  return token || '0';
}

function toLookupTextToken(value: string | number, maxSpaces: number): string {
  const normalized = String(value)
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  let spaces = 0;
  let token = '';
  for (const char of normalized) {
    if (char === ' ') {
      if (spaces >= maxSpaces) continue;
      spaces += 1;
    }

    token += char;
    if (token.length >= 100) break;
  }

  return token || '0';
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
