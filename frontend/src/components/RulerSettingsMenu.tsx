import React from 'react';
import { View, Text, Pressable, Modal } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { spacing, radius, typeScale } from '@/src/theme/tokens';
import { haptic } from '@/src/state/useAppSettings';
import type { RulerState } from '@/src/components/Ruler';

/**
 * Quick-settings popover for the ruler.
 *
 * Extracted out of `app/draw/[id].tsx` so the drawing screen stays readable and
 * the ruler-specific UI lives next to the Ruler component itself. Keeps its own
 * props explicit — no context / global state — so the drawing screen owns all
 * ruler state and this modal is a pure view.
 */
export interface RulerSettingsMenuProps {
  visible: boolean;
  onClose: () => void;
  rulerState: RulerState;
  onChangeRuler: React.Dispatch<React.SetStateAction<RulerState>>;
  onOpenAngleInput: () => void;
  onHide: () => void;
  viewport: { w: number; h: number };
  topOffset: number;                  // absolute px from the top of the screen (usually insets.top + 56)
  colors: {
    surface: string;
    surfaceSecondary: string;
    onSurface: string;
    onBrandPrimary: string;
    brand: string;
    muted: string;
    divider: string;
    error: string;
  };
}

export default function RulerSettingsMenu({
  visible,
  onClose,
  rulerState,
  onChangeRuler,
  onOpenAngleInput,
  onHide,
  viewport,
  topOffset,
  colors,
}: RulerSettingsMenuProps) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable style={{ flex: 1, backgroundColor: 'transparent' }} onPress={onClose}>
        <Pressable
          onPress={(e) => e.stopPropagation && e.stopPropagation()}
          style={{
            position: 'absolute',
            top: topOffset,
            right: 12,
            width: 240,
            backgroundColor: colors.surface,
            borderRadius: radius.md,
            padding: spacing.md,
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 4 },
            shadowOpacity: 0.22,
            shadowRadius: 16,
            elevation: 12,
          }}
        >
          <Text
            style={{
              color: colors.onSurface,
              fontWeight: '700',
              fontSize: typeScale.base,
              marginBottom: spacing.sm,
            }}
          >
            Ruler
          </Text>

          {/* Set angle */}
          <Pressable
            onPress={onOpenAngleInput}
            style={{ paddingVertical: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
            testID="ruler-menu-angle"
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Ionicons name="compass-outline" size={16} color={colors.onSurface} />
              <Text style={{ color: colors.onSurface, fontSize: typeScale.sm }}>Set angle</Text>
            </View>
            <Text style={{ color: colors.muted, fontSize: typeScale.sm, fontWeight: '600' }}>
              {`${Math.round(((rulerState.angle % 360) + 360) % 360)}°`}
            </Text>
          </Pressable>

          {/* Scale graduation with paper */}
          <Pressable
            onPress={() => {
              haptic.selection();
              onChangeRuler((prev) => ({ ...prev, scaleWithPaper: !prev.scaleWithPaper }));
            }}
            style={{ paddingVertical: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
            testID="ruler-menu-scale"
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Ionicons name="resize-outline" size={16} color={colors.onSurface} />
              <Text style={{ color: colors.onSurface, fontSize: typeScale.sm }}>Scale with paper</Text>
            </View>
            <View
              style={{
                paddingHorizontal: 8,
                paddingVertical: 2,
                borderRadius: 999,
                backgroundColor: rulerState.scaleWithPaper ? colors.brand : colors.surfaceSecondary,
              }}
            >
              <Text
                style={{
                  color: rulerState.scaleWithPaper ? colors.onBrandPrimary : colors.onSurface,
                  fontSize: 11,
                  fontWeight: '700',
                }}
              >
                {rulerState.scaleWithPaper ? 'On' : 'Off'}
              </Text>
            </View>
          </Pressable>

          {/* Units */}
          <Pressable
            onPress={() => {
              haptic.selection();
              onChangeRuler((prev) => ({ ...prev, unit: prev.unit === 'cm' ? 'in' : 'cm' }));
            }}
            style={{ paddingVertical: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
            testID="ruler-menu-unit"
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Ionicons name="swap-horizontal-outline" size={16} color={colors.onSurface} />
              <Text style={{ color: colors.onSurface, fontSize: typeScale.sm }}>Units</Text>
            </View>
            <Text style={{ color: colors.muted, fontSize: typeScale.sm, fontWeight: '600' }}>
              {rulerState.unit === 'cm' ? 'cm' : 'inches'}
            </Text>
          </Pressable>

          <View style={{ height: 1, backgroundColor: colors.divider, marginVertical: 4 }} />

          {/* Reset position/angle */}
          <Pressable
            onPress={() => {
              haptic.selection();
              onChangeRuler((prev) => ({
                ...prev,
                x: viewport.w / 2,
                y: viewport.h / 2,
                angle: 0,
              }));
              onClose();
            }}
            style={{ paddingVertical: 10, flexDirection: 'row', alignItems: 'center', gap: 8 }}
            testID="ruler-menu-reset"
          >
            <Ionicons name="refresh" size={16} color={colors.brand} />
            <Text style={{ color: colors.brand, fontSize: typeScale.sm, fontWeight: '600' }}>
              Recenter & straighten
            </Text>
          </Pressable>

          {/* Hide ruler */}
          <Pressable
            onPress={() => {
              haptic.selection();
              onHide();
              onClose();
            }}
            style={{ paddingVertical: 10, flexDirection: 'row', alignItems: 'center', gap: 8 }}
            testID="ruler-menu-hide"
          >
            <Ionicons name="eye-off-outline" size={16} color={colors.error} />
            <Text style={{ color: colors.error, fontSize: typeScale.sm, fontWeight: '600' }}>
              Hide ruler
            </Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
