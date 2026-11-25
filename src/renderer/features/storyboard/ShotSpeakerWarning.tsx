import { ShieldAlert } from "lucide-react";
import type { Asset, Shot } from "@shared/types/domain";

export function ShotSpeakerWarning(props: {
  currentShot: Shot;
  characterAssets: Asset[];
  needsSpeakerConfirm: boolean;
  hasUnlinkedCustomSpeaker: boolean;
  onSelectSpeaker: (speaker: string) => void;
}) {
  const {
    currentShot,
    characterAssets,
    needsSpeakerConfirm,
    hasUnlinkedCustomSpeaker,
    onSelectSpeaker,
  } = props;

  if (needsSpeakerConfirm) {
    return (
      <div
        data-testid="unconfirmed-speaker-banner"
        className="aivora-attention-in rounded-lg bg-[var(--accent-amber-soft)] border border-[var(--accent-amber-border)] px-2.5 py-2 flex flex-col gap-1.5 text-[11px] text-[var(--accent-amber-ink)]"
      >
        <div className="flex items-center gap-1.5 font-medium">
          <ShieldAlert className="w-3.5 h-3.5 text-[var(--accent-amber-text)] shrink-0" />
          <span>说话人待确认（防错配默认声线，已拦截配音）</span>
        </div>
        <div className="flex flex-wrap gap-1">
          {characterAssets.slice(0, 6).map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => onSelectSpeaker(c.name)}
              className="aivora-pressable px-2 py-0.5 rounded bg-[var(--bg-surface)] border border-[var(--accent-amber-border)] text-[var(--text-primary)] hover:border-[var(--accent-primary)] cursor-pointer"
            >
              确认为 {c.name}
            </button>
          ))}
          <button
            type="button"
            onClick={() => onSelectSpeaker("旁白")}
            className="aivora-pressable px-2 py-0.5 rounded bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
          >
            设为旁白
          </button>
        </div>
      </div>
    );
  }

  if (hasUnlinkedCustomSpeaker) {
    return (
      <div className="text-[10px] text-[var(--accent-amber-text)] px-0.5">
        「{currentShot.speaker.trim()}」未匹配已建档角色，将用默认声线；建议从下拉选择规范角色名。
      </div>
    );
  }

  return null;
}
