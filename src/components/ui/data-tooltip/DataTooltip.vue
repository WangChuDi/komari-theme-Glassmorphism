<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { computed } from 'vue'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

type DataTooltipPlacement = 'top' | 'bottom' | 'left' | 'right'

interface Props {
  /** 提示文本，留空且无 #content 插槽时不渲染气泡 */
  content?: string
  /** 气泡相对触发元素的方位 */
  placement?: DataTooltipPlacement
  /** 气泡宽度，number 视为 px；默认由内容撑起 */
  width?: number | string
  /** 气泡高度，number 视为 px；默认由内容撑起 */
  height?: number | string
  /** 包裹元素标签，默认 div */
  as?: string
  /** 包裹元素的附加类 */
  class?: HTMLAttributes['class']
  /** 气泡的附加类 */
  contentClass?: HTMLAttributes['class']
}

const props = withDefaults(defineProps<Props>(), {
  placement: 'top',
  as: 'div',
})

const sizeStyle = computed(() => {
  const style: Record<string, string> = {}
  if (props.width != null)
    style.width = typeof props.width === 'number' ? `${props.width}px` : props.width
  if (props.height != null)
    style.height = typeof props.height === 'number' ? `${props.height}px` : props.height
  return style
})
</script>

<template>
  <Tooltip>
    <TooltipTrigger as-child>
      <component
        :is="as"
        data-slot="data-tooltip"
        :class="cn('group/data-tooltip relative inline-block', props.class)"
      >
        <slot />
      </component>
    </TooltipTrigger>
    <TooltipContent
      v-if="content || $slots.content"
      :side="placement"
      :side-offset="8"
      :class="cn(
        'pointer-events-none block w-max max-w-[calc(100vw-1rem)] whitespace-pre-line break-normal rounded px-2 py-1.5 text-left text-[11px] leading-snug shadow-lg sm:max-w-xs',
        props.contentClass,
      )"
      :style="sizeStyle"
    >
      <slot name="content">
        {{ content }}
      </slot>
    </TooltipContent>
  </Tooltip>
</template>
