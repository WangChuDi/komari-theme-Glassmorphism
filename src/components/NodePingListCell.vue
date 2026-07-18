<script setup lang="ts">
import { computed } from 'vue'
import { useNodePingDisplay, useNodePingMultiDisplay } from '@/composables/useNodePingDisplay'
import { useAppStore } from '@/stores/app'

const props = defineProps<{
  uuid: string
  online: boolean
}>()

const emit = defineEmits<{
  click: []
}>()

const appStore = useAppStore()
const showMultiPingDisplay = computed(() => appStore.homePingDisplayMode === 'multi')
const {
  latencyRenderBars,
  lossRenderBars,
} = useNodePingDisplay(() => props.uuid, {
  enabled: computed(() => !showMultiPingDisplay.value),
})
const {
  rows: networkPingRows,
  emptyText: networkPingEmptyText,
} = useNodePingMultiDisplay(() => props.uuid, {
  enabled: showMultiPingDisplay,
  loadingDisplayText: '...',
})
</script>

<template>
  <button
    type="button"
    class="group flex w-full flex-col text-left"
    :class="showMultiPingDisplay ? 'gap-0.5 pr-1' : 'gap-[1px] pr-4'"
    aria-label="打开延迟和丢包监测"
    @click.stop="emit('click')"
  >
    <template v-if="showMultiPingDisplay">
      <div
        v-if="networkPingRows.length"
        class="grid gap-[1px] leading-none"
        :class="[!props.online && 'blur-xs opacity-50']"
      >
        <div
          v-for="row in networkPingRows"
          :key="row.key"
          class="grid grid-cols-[2.2rem_minmax(0,1fr)_minmax(0,1fr)] items-center gap-1 text-[10px]"
          :title="row.tooltip"
          :aria-label="row.tooltip"
        >
          <span class="truncate text-muted-foreground">{{ row.label }}</span>
          <span class="inline-flex min-w-0 items-center gap-0.5 font-medium tabular-nums">
            <span class="size-1 shrink-0 rounded-full" :class="row.latencyToneClass" />
            <span class="min-w-0 truncate">{{ row.latencyDisplay }}</span>
          </span>
          <span class="inline-flex min-w-0 items-center gap-0.5 font-medium tabular-nums">
            <span class="size-1 shrink-0 rounded-full" :class="row.lossToneClass" />
            <span class="min-w-0 truncate">{{ row.lossDisplay }}</span>
          </span>
        </div>
      </div>
      <span v-else class="text-[10px] text-muted-foreground">
        {{ networkPingEmptyText }}
      </span>
    </template>

    <template v-else>
      <div class="group/panel relative items-center gap-1 opacity-80 hover:opacity-100">
        <div
          class="grid h-1 cursor-auto items-end gap-[1px] transition-all hover:h-2.5"
          :style="{ gridTemplateColumns: `repeat(${latencyRenderBars.length}, minmax(0, 1fr))` }"
        >
          <span
            v-for="bar in latencyRenderBars"
            :key="bar.key"
            :title="bar.tooltip"
            :aria-label="bar.tooltip"
            class="h-full w-full"
          >
            <span class="block h-full w-full rounded-[1px] transition-all group-hover:opacity-50 hover:scale-y-160 hover:opacity-100" :class="bar.className" />
          </span>
        </div>
      </div>
      <div class="group/panel relative items-center gap-1 opacity-80 hover:opacity-100">
        <div
          class="grid h-1 cursor-auto items-end gap-[1px] transition-all hover:h-2.5"
          :style="{ gridTemplateColumns: `repeat(${lossRenderBars.length}, minmax(0, 1fr))` }"
        >
          <span
            v-for="bar in lossRenderBars"
            :key="bar.key"
            :title="bar.tooltip"
            :aria-label="bar.tooltip"
            class="h-full w-full"
          >
            <span class="block h-full w-full rounded-[1px] transition-all group-hover:opacity-50 hover:scale-y-160 hover:opacity-100" :class="bar.className" />
          </span>
        </div>
      </div>
    </template>
  </button>
</template>
