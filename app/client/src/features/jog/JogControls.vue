<!--
  This file is part of ncSender.

  ncSender is free software: you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation, either version 3 of the License, or
  (at your option) any later version.

  ncSender is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with ncSender. If not, see <https://www.gnu.org/licenses/>.
-->

<template>
  <div class="jog-controls" :class="[{ 'jog-disabled': disabled }, customClass]">
    <!-- XY Joystick + Z Controls -->
    <div class="jog-grid">
      <!-- XY Joystick (3x3 grid) -->
      <div class="jog-xy">
        <!-- Top Row -->
        <button
          :class="['jog-btn', 'jog-corner', { pressed: isButtonPressed('diagonal--1-1') }]"
          aria-label="Jog X negative Y positive"
          @pointerdown="handleJogDiagonalStart(-1, 1, $event)"
          @pointerup="handleJogDiagonalEnd(-1, 1, $event)"
          @lostpointercapture="handleLostPointerCapture"
        >↖</button>
        <button
          :class="['jog-btn', 'jog-axis', { pressed: isButtonPressed('Y-1') }]"
          aria-label="Jog Y positive"
          @pointerdown="handleJogStart('Y', 1, $event)"
          @pointerup="handleJogEnd('Y', 1, $event)"
          @lostpointercapture="handleLostPointerCapture"
        >Y+</button>
        <button
          :class="['jog-btn', 'jog-corner', { pressed: isButtonPressed('diagonal-1-1') }]"
          aria-label="Jog X positive Y positive"
          @pointerdown="handleJogDiagonalStart(1, 1, $event)"
          @pointerup="handleJogDiagonalEnd(1, 1, $event)"
          @lostpointercapture="handleLostPointerCapture"
        >↗</button>

        <!-- Middle Row -->
        <button
          :class="['jog-btn', 'jog-axis', { pressed: isButtonPressed('X--1') }]"
          aria-label="Jog X negative"
          @pointerdown="handleJogStart('X', -1, $event)"
          @pointerup="handleJogEnd('X', -1, $event)"
          @lostpointercapture="handleLostPointerCapture"
        >X-</button>
        <button class="jog-center" @click="handleCenterClick" aria-label="Soft Reset" title="Stop / Soft Reset">
          <svg viewBox="0 0 24 24" fill="currentColor" class="stop-icon">
            <rect x="6" y="6" width="12" height="12" rx="1" />
          </svg>
        </button>
        <button
          :class="['jog-btn', 'jog-axis', { pressed: isButtonPressed('X-1') }]"
          aria-label="Jog X positive"
          @pointerdown="handleJogStart('X', 1, $event)"
          @pointerup="handleJogEnd('X', 1, $event)"
          @lostpointercapture="handleLostPointerCapture"
        >X+</button>

        <!-- Bottom Row -->
        <button
          :class="['jog-btn', 'jog-corner', { pressed: isButtonPressed('diagonal--1--1') }]"
          aria-label="Jog X negative Y negative"
          @pointerdown="handleJogDiagonalStart(-1, -1, $event)"
          @pointerup="handleJogDiagonalEnd(-1, -1, $event)"
          @lostpointercapture="handleLostPointerCapture"
        >↙</button>
        <button
          :class="['jog-btn', 'jog-axis', { pressed: isButtonPressed('Y--1') }]"
          aria-label="Jog Y negative"
          @pointerdown="handleJogStart('Y', -1, $event)"
          @pointerup="handleJogEnd('Y', -1, $event)"
          @lostpointercapture="handleLostPointerCapture"
        >Y-</button>
        <button
          :class="['jog-btn', 'jog-corner', { pressed: isButtonPressed('diagonal-1--1') }]"
          aria-label="Jog X positive Y negative"
          @pointerdown="handleJogDiagonalStart(1, -1, $event)"
          @pointerup="handleJogDiagonalEnd(1, -1, $event)"
          @lostpointercapture="handleLostPointerCapture"
        >↘</button>
      </div>

      <!-- Z Controls -->
      <div class="jog-z">
        <button
          :class="['jog-btn', 'jog-z-btn', { pressed: isButtonPressed('Z-1') }]"
          aria-label="Jog Z positive"
          @pointerdown="handleJogStart('Z', 1, $event)"
          @pointerup="handleJogEnd('Z', 1, $event)"
          @lostpointercapture="handleLostPointerCapture"
        >Z+</button>
        <button
          :class="['jog-btn', 'jog-z-btn', { pressed: isButtonPressed('Z--1') }]"
          aria-label="Jog Z negative"
          @pointerdown="handleJogStart('Z', -1, $event)"
          @pointerup="handleJogEnd('Z', -1, $event)"
          @lostpointercapture="handleLostPointerCapture"
        >Z-</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { api, jogStart, jogStop, jogStep } from './api';
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { useAppStore } from '@/composables/use-app-store';

const props = withDefaults(defineProps<{
  currentStep?: number;
  disabled?: boolean;
  feedRate?: number;
  customClass?: string;
  xTravel?: number;
  yTravel?: number;
  zTravel?: number;
}>(), {
  currentStep: 1,
  feedRate: 2000,
  disabled: false
});

const { unitsPreference } = useAppStore();

// Format step size for commands - value is already in display units (mm or inches)
const formatStepForCommand = (value: number): string => {
  return value.toFixed(4).replace(/\.?0+$/, '');
};

// Format feed rate for commands - value is already in display units (mm/min or in/min)
const formatFeedRateForCommand = (value: number): string => {
  return Math.round(value).toString();
};

let jogTimer: number | null = null;

// Handle center button click - send soft reset
const handleCenterClick = async () => {
  try {
    await api.sendCommandViaWebSocket({
      command: String.fromCharCode(0x18)
    });
  } catch (error) {
    console.error('Failed to send soft reset:', error);
  }
};
let isLongPress = false;
let activeJogId: string | null = null;
let jogPressActive = false;
let activePointerId: number | null = null;

const handleGlobalRelease = () => {
  if (!jogPressActive) return;
  jogPressActive = false;
  activePointerId = null;

  if (jogTimer) {
    clearTimeout(jogTimer);
    jogTimer = null;
  }
  pressedButtons.value.clear();

  if (isLongPress && activeJogId) {
    jogDebug('global-safety-release', `activeJogId=${activeJogId}`);
    stopJog();
  }
};

const handleLostPointerCapture = (event: PointerEvent) => {
  if (event.pointerId !== activePointerId) return;
  activePointerId = null;
  jogPressActive = false;
  pressedButtons.value.clear();

  if (jogTimer) {
    clearTimeout(jogTimer);
    jogTimer = null;
  }

  if (isLongPress && activeJogId) {
    jogDebug('lost-capture-safety', `activeJogId=${activeJogId}`);
    stopJog();
  }
};

const jogDebug = (event: string, detail?: string) => {
  console.log(`[JogDebug] ${event}${detail ? ': ' + detail : ''} t=${Date.now()}`);
  api.sendWebSocketMessage('jog:debug', { event, detail }).catch(() => {});
};

const createJogId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;

// Track which buttons are pressed for visual feedback
const pressedButtons = ref(new Set<string>());

const DEFAULT_CONTINUOUS_DISTANCE = 400;

const getAxisTravel = (axis: 'X' | 'Y' | 'Z'): number => {
  const raw = axis === 'X' ? props.xTravel : axis === 'Y' ? props.yTravel : props.zTravel;
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (Number.isFinite(value) && value > 0) {
    return value;
  }
  return DEFAULT_CONTINUOUS_DISTANCE;
};

const jog = async (axis: 'X' | 'Y' | 'Z', direction: 1 | -1) => {
  const isImperial = unitsPreference.value === 'imperial';
  const unitsCode = isImperial ? 'G20' : 'G21';
  const stepFormatted = formatStepForCommand(props.currentStep);
  const feedRateRaw = axis === 'Z' ? props.feedRate / 2 : props.feedRate;
  const feedRateFormatted = formatFeedRateForCommand(feedRateRaw);
  const distanceSign = direction > 0 ? '' : '-';
  const command = `$J=${unitsCode} G91 ${axis}${distanceSign}${stepFormatted} F${feedRateFormatted}`;
  try {
    await jogStep({
      command,
      displayCommand: command,
      axis,
      direction,
      feedRate: feedRateRaw,
      distance: Number(stepFormatted) * direction
    });
  } catch (error) {
    console.error('Failed to execute jog step:', error);
  }
};

const jogDiagonal = async (xDirection: 1 | -1, yDirection: 1 | -1) => {
  const isImperial = unitsPreference.value === 'imperial';
  const unitsCode = isImperial ? 'G20' : 'G21';
  const stepFormatted = formatStepForCommand(props.currentStep);
  const feedRateFormatted = formatFeedRateForCommand(props.feedRate);
  const xSign = xDirection > 0 ? '' : '-';
  const ySign = yDirection > 0 ? '' : '-';
  const command = `$J=${unitsCode} G91 X${xSign}${stepFormatted} Y${ySign}${stepFormatted} F${feedRateFormatted}`;
  try {
    await jogStep({
      command,
      displayCommand: command,
      axis: 'XY',
      direction: null,
      feedRate: props.feedRate,
      distance: { x: Number(stepFormatted) * xDirection, y: Number(stepFormatted) * yDirection }
    });
  } catch (error) {
    console.error('Failed to execute diagonal jog step:', error);
  }
};

const continuousJog = async (axis: 'X' | 'Y' | 'Z', direction: 1 | -1) => {
  const isImperial = unitsPreference.value === 'imperial';
  const unitsCode = isImperial ? 'G20' : 'G21';
  const feedRateRaw = axis === 'Z' ? props.feedRate / 2 : props.feedRate;
  const feedRateFormatted = formatFeedRateForCommand(feedRateRaw);
  const travel = getAxisTravel(axis);
  const travelFormatted = formatStepForCommand(travel);
  const travelSign = direction > 0 ? '' : '-';
  const command = `$J=${unitsCode} G91 ${axis}${travelSign}${travelFormatted} F${feedRateFormatted}`;
  const jogId = createJogId();
  activeJogId = jogId;
  jogDebug('continuous-start', `${axis}${direction > 0 ? '+' : '-'} jogId=${jogId} cmd=${command}`);

  try {
    await jogStart({
      jogId,
      command,
      displayCommand: command,
      axis,
      direction,
      feedRate: feedRateRaw
    });
  } catch (error) {
    jogDebug('continuous-start-FAILED', `jogId=${jogId} err=${(error as Error)?.message}`);
    console.error('Failed to start continuous jog:', error);
    if (activeJogId === jogId) {
      activeJogId = null;
    }
  }
};

const continuousDiagonalJog = async (xDirection: 1 | -1, yDirection: 1 | -1) => {
  const travel = Math.min(getAxisTravel('X'), getAxisTravel('Y'));
  const isImperial = unitsPreference.value === 'imperial';
  const unitsCode = isImperial ? 'G20' : 'G21';
  const travelFormatted = formatStepForCommand(travel);
  const feedRateFormatted = formatFeedRateForCommand(props.feedRate);
  const xSign = xDirection > 0 ? '' : '-';
  const ySign = yDirection > 0 ? '' : '-';
  const command = `$J=${unitsCode} G91 X${xSign}${travelFormatted} Y${ySign}${travelFormatted} F${feedRateFormatted}`;
  const jogId = createJogId();
  activeJogId = jogId;
  jogDebug('diagonal-continuous-start', `X${xSign}Y${ySign} jogId=${jogId} cmd=${command}`);

  try {
    await jogStart({
      jogId,
      command,
      displayCommand: command,
      axis: 'XY',
      direction: null,
      feedRate: props.feedRate
    });
  } catch (error) {
    jogDebug('diagonal-continuous-start-FAILED', `jogId=${jogId} err=${(error as Error)?.message}`);
    console.error('Failed to start diagonal continuous jog:', error);
    if (activeJogId === jogId) {
      activeJogId = null;
    }
  }
};

const handleJogStart = (axis: 'X' | 'Y' | 'Z', direction: 1 | -1, event: PointerEvent) => {
  event.preventDefault();

  if (props.disabled || activePointerId !== null) return;

  activePointerId = event.pointerId;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);

  jogPressActive = true;
  jogDebug('button-press', `${axis}${direction > 0 ? '+' : '-'}`);
  const buttonId = getButtonId(axis, direction);
  setButtonPressed(buttonId);

  isLongPress = false;
  jogTimer = setTimeout(() => {
    isLongPress = true;
    continuousJog(axis, direction);
  }, 300);
};

const handleJogDiagonalStart = (xDirection: 1 | -1, yDirection: 1 | -1, event: PointerEvent) => {
  event.preventDefault();

  if (props.disabled || activePointerId !== null) return;

  activePointerId = event.pointerId;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);

  jogPressActive = true;
  jogDebug('button-press', `diagonal X${xDirection > 0 ? '+' : '-'}Y${yDirection > 0 ? '+' : '-'}`);
  const buttonId = getButtonId('', undefined, xDirection, yDirection);
  setButtonPressed(buttonId);

  isLongPress = false;
  jogTimer = setTimeout(() => {
    isLongPress = true;
    continuousDiagonalJog(xDirection, yDirection);
  }, 300);
};

const handleJogEnd = (axis: 'X' | 'Y' | 'Z', direction: 1 | -1, event: PointerEvent) => {
  event.preventDefault();

  if (event.pointerId !== activePointerId) return;

  activePointerId = null;
  jogPressActive = false;
  jogDebug('button-release', `${axis}${direction > 0 ? '+' : '-'} isLongPress=${isLongPress} activeJogId=${activeJogId}`);
  const buttonId = getButtonId(axis, direction);
  setButtonReleased(buttonId);

  if (jogTimer) {
    clearTimeout(jogTimer);
    jogTimer = null;
  }
  if (isLongPress) {
    stopJog();
  } else {
    void jog(axis, direction);
  }
};

const handleJogDiagonalEnd = (xDirection: 1 | -1, yDirection: 1 | -1, event: PointerEvent) => {
  event.preventDefault();

  if (event.pointerId !== activePointerId) return;

  activePointerId = null;
  jogPressActive = false;
  jogDebug('button-release', `diagonal X${xDirection > 0 ? '+' : '-'}Y${yDirection > 0 ? '+' : '-'} isLongPress=${isLongPress} activeJogId=${activeJogId}`);
  const buttonId = getButtonId('', undefined, xDirection, yDirection);
  setButtonReleased(buttonId);

  if (jogTimer) {
    clearTimeout(jogTimer);
    jogTimer = null;
  }
  if (isLongPress) {
    stopJog();
  } else {
    void jogDiagonal(xDirection, yDirection);
  }
};

const stopJog = async () => {
  if (!activeJogId) {
    jogDebug('stop-skipped', 'no activeJogId');
    return;
  }

  const jogId = activeJogId;
  activeJogId = null;
  jogDebug('stop-cancel-sending', `jogId=${jogId} sending 0x85`);

  try {
    await api.sendCommandViaWebSocket({
      command: String.fromCharCode(0x85)
    });
    jogDebug('stop-cancel-sent', `jogId=${jogId} 0x85 delivered`);
  } catch (error) {
    jogDebug('stop-cancel-FAILED', `jogId=${jogId} err=${(error as Error)?.message}`);
    console.error('Failed to send immediate jog cancel:', error);
  }

  jogStop(jogId).catch((error) => {
    jogDebug('stop-session-FAILED', `jogId=${jogId} err=${(error as Error)?.message}`);
    console.error('Failed to stop jog session:', error);
  });
};

// Helper functions for button visual feedback
const getButtonId = (axis: string, direction?: number, xDir?: number, yDir?: number) => {
  if (xDir !== undefined && yDir !== undefined) {
    return `diagonal-${xDir}-${yDir}`;
  }
  return `${axis}-${direction}`;
};

const setButtonPressed = (buttonId: string) => {
  pressedButtons.value.add(buttonId);
};

const setButtonReleased = (buttonId: string) => {
  pressedButtons.value.delete(buttonId);
};

const isButtonPressed = (buttonId: string) => {
  return pressedButtons.value.has(buttonId);
};

let unsubscribeJogStopped: (() => void) | null = null;

const handleWindowBlur = () => {
  if (activeJogId) {
    jogDebug('window-blur-safety', `activeJogId=${activeJogId}`);
    activePointerId = null;
    jogPressActive = false;
    pressedButtons.value.clear();
    if (jogTimer) {
      clearTimeout(jogTimer);
      jogTimer = null;
    }
    stopJog();
  }
};

onMounted(() => {
  document.addEventListener('pointerup', handleGlobalRelease);
  document.addEventListener('pointercancel', handleGlobalRelease);
  window.addEventListener('blur', handleWindowBlur);

  unsubscribeJogStopped = api.on('jog:stopped', (data) => {
    if (!data || !data.jogId) {
      return;
    }
    if (activeJogId && data.jogId === activeJogId) {
      activeJogId = null;
    }
  });
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerup', handleGlobalRelease);
  document.removeEventListener('pointercancel', handleGlobalRelease);
  window.removeEventListener('blur', handleWindowBlur);

  if (jogTimer) {
    clearTimeout(jogTimer);
    jogTimer = null;
  }

  if (activeJogId) {
    jogDebug('unmount-safety', `activeJogId=${activeJogId}`);
    stopJog();
  }

  if (unsubscribeJogStopped) {
    unsubscribeJogStopped();
    unsubscribeJogStopped = null;
  }
});
</script>

<style scoped>
.jog-controls {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
}

.jog-disabled {
  pointer-events: none;
}

/* Disable all elements except center button */
.jog-disabled .jog-btn {
  opacity: 0.5;
}

.jog-disabled .jog-z {
  opacity: 0.5;
}

/* Stop button is ALWAYS enabled - even when jog is disabled (for emergency stop/unlock) */
.jog-disabled .jog-center {
  pointer-events: auto !important;
  opacity: 1 !important;
  cursor: pointer !important;
}

.jog-grid {
  display: flex;
  gap: 4px;
  align-items: stretch;
  justify-content: center;
  height: 100%;

}

.jog-xy {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  grid-template-rows: repeat(3, 1fr);
  gap: 4px;
  width: 180px;
  height: 100%

}

.jog-controls.jog-controls-probe {
  height: unset;
}

.jog-controls-probe .jog-grid {
  height: unset;
}

.jog-controls-probe .jog-xy {

  height: 180px !important;;
}

.jog-controls-mobile .jog-xy {
  width: 100% !important;
}

.jog-controls-mobile .jog-z {
  width: 90px !important;
}

.plugin-dialog .jog-xy{
   width: 180px !important;
}



.jog-z {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 60px;
}

.jog-btn {
  border-radius: var(--radius-small) !important;
  border: 1px solid var(--color-border) !important;
  background: var(--color-surface-muted) !important;
  font-size: 1rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
  user-select: none;
  color: var(--color-text-primary) !important;
  -webkit-touch-callout: default;
  touch-action: none;
  padding: unset !important;
}

.jog-btn:hover {
  border: 1px solid var(--color-accent);
}

.jog-btn:active,
.jog-btn.pressed {
  background: var(--color-accent);
  color: white;
  transform: scale(0.98);
  box-shadow: 0 0 10px rgba(26, 188, 156, 0.5);
  border: 1px solid var(--color-accent);
}

.jog-corner {
  font-size: 1.2rem;
}

.jog-axis {
  font-weight: bold;
}

.jog-z-btn {
  flex: 1;
  font-weight: bold;
}

.jog-center {
  width: 100%;
  height: 100%;
  border: 1px solid #dc2626 !important;
  border-radius: var(--radius-small) !important;
  background: #dc2626 !important;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.2s ease;
  color: white !important;
  font-size: 1rem;
  font-weight: 600;
  user-select: none;
  -webkit-touch-callout: default;
  touch-action: none;
  padding: unset !important;
}

.jog-center:hover {
  background: #b91c1c !important;
  border-color: #b91c1c !important;
}

.jog-center:active {
  background: #991b1b !important;
  border-color: #991b1b !important;
  transform: scale(0.98);
}

.jog-center .stop-icon {
  width: 20px;
  height: 20px;
  color: white;
}
</style>
