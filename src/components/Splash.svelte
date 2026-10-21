<script lang="ts">
  /** 启动动画：纯 CSS 的科技感过场，约 1.5 秒后自动淡出，点击可跳过。
   *  不阻塞 App 初始化（App 在背后正常加载），也不引入任何依赖。 */
  import { onMount } from 'svelte';
  import logoUrl from '../../assets/logo.svg';

  interface Props {
    onDone: () => void;
  }
  let { onDone }: Props = $props();

  let leaving = $state(false);
  let done = false;

  function finish() {
    if (done) return;
    done = true;
    leaving = true;
    setTimeout(onDone, 420);
  }

  onMount(() => {
    const reduce = typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    if (reduce) {
      finish();
      return;
    }
    const timer = setTimeout(finish, 1500);
    return () => clearTimeout(timer);
  });
</script>

<div class="splash" class:leaving role="button" tabindex="0" aria-label="跳过启动动画"
  onclick={finish}
  onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); finish(); } }}>
  <div class="grid"></div>
  <div class="glow"></div>
  <div class="scan"></div>

  <div class="core">
    <div class="logo-wrap">
      <div class="rings"><i></i><i></i><i></i></div>
      <img class="logo" src={logoUrl} alt="" />
    </div>
    <div class="title">ANNOTATOR<span>PRO</span></div>
    <div class="sub">TARGET DETECTION · CLASSIFICATION · SEGMENTATION</div>
    <div class="bar"><i></i></div>
    <div class="hint">点击任意位置跳过</div>
  </div>
</div>

<style>
  .splash {
    position: fixed; inset: 0; z-index: 9999;
    display: flex; align-items: center; justify-content: center;
    background:
      radial-gradient(900px 480px at 50% 42%, rgba(34, 211, 238, 0.13), transparent 62%),
      radial-gradient(700px 420px at 72% 78%, rgba(167, 139, 250, 0.10), transparent 60%),
      #05080f;
    overflow: hidden;
    opacity: 1;
    transition: opacity 420ms ease, transform 420ms ease;
  }
  .splash.leaving { opacity: 0; transform: scale(1.015); pointer-events: none; }

  /* 透视网格：慢速向上滚动 */
  .grid {
    position: absolute; left: -25%; right: -25%; bottom: -42%; height: 115%;
    background-image:
      linear-gradient(rgba(34, 211, 238, 0.10) 1px, transparent 1px),
      linear-gradient(90deg, rgba(34, 211, 238, 0.10) 1px, transparent 1px);
    background-size: 46px 46px;
    transform: perspective(620px) rotateX(62deg);
    transform-origin: center bottom;
    animation: gridMove 2.4s linear infinite;
    mask-image: linear-gradient(to top, rgba(0,0,0,0.85), transparent 78%);
    -webkit-mask-image: linear-gradient(to top, rgba(0,0,0,0.85), transparent 78%);
  }
  @keyframes gridMove {
    from { background-position: 0 0, 0 0; }
    to { background-position: 0 -46px, 0 0; }
  }

  .glow {
    position: absolute; width: 420px; height: 420px; border-radius: 50%;
    background: radial-gradient(circle, rgba(34, 211, 238, 0.20), rgba(34, 211, 238, 0) 68%);
    filter: blur(8px);
    animation: breathe 2.2s ease-in-out infinite;
  }
  @keyframes breathe {
    0%, 100% { transform: scale(0.92); opacity: 0.7; }
    50% { transform: scale(1.08); opacity: 1; }
  }

  /* 扫描线 */
  .scan {
    position: absolute; left: 0; right: 0; height: 1px;
    background: linear-gradient(90deg, transparent, rgba(34, 211, 238, 0.85), transparent);
    box-shadow: 0 0 14px rgba(34, 211, 238, 0.65);
    animation: scanDown 1.5s cubic-bezier(.4,0,.6,1) infinite;
  }
  @keyframes scanDown {
    0% { top: -2%; opacity: 0; }
    15% { opacity: 1; }
    85% { opacity: 1; }
    100% { top: 102%; opacity: 0; }
  }

  .core {
    position: relative; z-index: 2;
    display: flex; flex-direction: column; align-items: center;
    gap: 18px; padding: 0 24px; text-align: center;
  }

  .logo-wrap { position: relative; width: 190px; height: 190px; display: grid; place-items: center; }
  .logo {
    width: 168px; max-height: 168px; object-fit: contain;
    filter: drop-shadow(0 0 18px rgba(34, 211, 238, 0.55));
    animation: logoIn 700ms cubic-bezier(.2,.9,.25,1) both;
  }
  @keyframes logoIn {
    from { opacity: 0; transform: translateY(10px) scale(0.88); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }

  .rings { position: absolute; inset: 0; display: grid; place-items: center; }
  .rings i {
    position: absolute; border: 1px solid rgba(34, 211, 238, 0.35); border-radius: 50%;
    width: 120px; height: 120px; opacity: 0;
    animation: ringOut 2s ease-out infinite;
  }
  .rings i:nth-child(2) { animation-delay: 0.65s; }
  .rings i:nth-child(3) { animation-delay: 1.3s; }
  @keyframes ringOut {
    0% { transform: scale(0.75); opacity: 0.55; }
    100% { transform: scale(1.45); opacity: 0; }
  }

  .title {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 30px; font-weight: 700; letter-spacing: 0.32em;
    color: #e6f7ff; text-indent: 0.32em;
    animation: titleIn 700ms 120ms cubic-bezier(.2,.9,.25,1) both;
  }
  .title span { color: #22d3ee; text-shadow: 0 0 18px rgba(34, 211, 238, 0.55); }
  @keyframes titleIn {
    from { opacity: 0; letter-spacing: 0.55em; filter: blur(3px); }
    to { opacity: 1; letter-spacing: 0.32em; filter: blur(0); }
  }

  .sub {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 10px; letter-spacing: 0.22em; color: rgba(230, 247, 255, 0.55);
    animation: fadeUp 600ms 260ms both;
  }
  @keyframes fadeUp {
    from { opacity: 0; transform: translateY(6px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .bar { width: 220px; height: 2px; background: rgba(34, 211, 238, 0.16); overflow: hidden; }
  .bar i {
    display: block; height: 100%; width: 0;
    background: linear-gradient(90deg, #22d3ee, #a78bfa);
    box-shadow: 0 0 10px rgba(34, 211, 238, 0.7);
    animation: barFill 1.25s 180ms cubic-bezier(.3,.7,.3,1) forwards;
  }
  @keyframes barFill { to { width: 100%; } }

  .hint {
    font-size: 10px; letter-spacing: 0.12em; color: rgba(230, 247, 255, 0.35);
    animation: fadeUp 500ms 700ms both;
  }

  @media (prefers-reduced-motion: reduce) {
    .grid, .glow, .scan, .logo, .rings i, .title, .sub, .bar i, .hint { animation: none; }
    .bar i { width: 100%; }
    .rings i { opacity: 0; }
  }
</style>
