export type DeviceKind = "extension" | "mobile";

export interface Device {
  id: string;
  userId: string;
  kind: DeviceKind;
  label: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export interface PairingOffer {
  id: string;
  userId: string;
  expiresAt: string;
  consumedAt: string | null;
  createdAt: string;
}
