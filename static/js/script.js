// 前端交互脚本

const BASE = window.location.origin;
const HOST = window.location.host;

// 自动填充所有域名字段
function fillDomains() {
  const ids = ['release-url', 'clone-url', 'raw-url', 'archive-url', 'docker-config', 'docker-pull', 'docker-login', 'auth-url'];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    
    if (id === 'docker-config') {
      el.textContent = '"' + BASE + '"';
    } else if (id === 'release-url') {
      el.textContent = BASE + '/gh/owner/repo/releases/download/v1.0/app.tar.gz';
    } else if (id === 'clone-url') {
      el.textContent = BASE + '/gh/owner/repo.git';
    } else if (id === 'raw-url') {
      el.textContent = BASE + '/ghraw/owner/repo/main/README.md';
    } else if (id === 'archive-url') {
      el.textContent = BASE + '/gh/owner/repo/archive/refs/heads/main.zip';
    } else {
      el.textContent = BASE;
    }
  });
}

fillDomains();

// Toast 通知
function showToast(message) {
  const toast = document.getElementById('toast');
  const toastMessage = document.getElementById('toastMessage');
  toastMessage.textContent = message;
  toast.classList.add('toast--visible');
  setTimeout(() => {
    toast.classList.remove('toast--visible');
  }, 3000);
}

// 表单处理
const githubForm = document.getElementById('github-form');
const githubLinkInput = document.getElementById('githubLinkInput');
const formattedLinkOutput = document.getElementById('formattedLinkOutput');
const output = document.getElementById('output');
const copyButton = document.getElementById('copyButton');
const openButton = document.getElementById('openButton');
const githubLinkError = document.getElementById('githubLinkError');
const formatToggle = document.getElementById('format-toggle');
const slider = document.querySelector('.segmented-control__slider');

function generateOutput(userInput, format) {
  let normalizedLink = userInput.trim();

  try {
    if (format === 'docker') {
      if (normalizedLink.includes('/') && !normalizedLink.includes(' ') && !normalizedLink.startsWith('http')) {
        return { link: `docker pull ${HOST}/${normalizedLink}`, isUrl: false };
      }
      return { error: '请输入有效的 Docker 镜像名 (例如: owner/repo)' };
    }
    
    if (!/^https?:\/\//i.test(normalizedLink)) {
      normalizedLink = 'https://' + normalizedLink;
    }

    const url = new URL(normalizedLink);
    const path = url.pathname;
    const host = url.hostname;

    let proxyPath = '';
    if (host === 'github.com') {
      proxyPath = '/gh' + path;
    } else if (host === 'raw.githubusercontent.com') {
      proxyPath = '/ghraw' + path;
    } else if (host === 'codeload.github.com') {
      proxyPath = '/codeload' + path;
    } else if (host === 'objects.githubusercontent.com') {
      proxyPath = '/objects' + path;
    } else if (host === 'release-assets.githubusercontent.com') {
      proxyPath = '/release-assets' + path;
    } else if (host === 'api.github.com') {
      proxyPath = '/api.github.com' + path;
    } else if (host === 'docker.io' || host === 'registry-1.docker.io') {
      proxyPath = path;
    } else if (host === 'ghcr.io') {
      proxyPath = '/ghcr' + path;
    } else if (host === 'gcr.io') {
      proxyPath = '/gcr' + path;
    } else if (host === 'registry.k8s.io') {
      proxyPath = '/k8s' + path;
    } else if (host === 'quay.io') {
      proxyPath = '/quay' + path;
    } else {
      return { error: '不支持该域名' };
    }

    const directLink = BASE + proxyPath;

    switch (format) {
      case 'git':
        if (path.endsWith('.git')) {
          return { link: `git clone ${directLink}`, isUrl: false };
        }
        return { error: 'Git Clone 需要以 .git 结尾的仓库链接' };
      case 'wget':
        return { link: `wget "${directLink}"`, isUrl: false };
      case 'direct':
      default:
        return { link: directLink, isUrl: true };
    }
  } catch (e) {
    return { error: '请输入一个有效的 URL' };
  }
}

function handleFormAction() {
  githubLinkError.textContent = '';
  githubLinkError.classList.remove('text-field__error--visible');

  const githubLink = githubLinkInput.value.trim();
  const selectedFormat = formatToggle.querySelector('.active').dataset.value;

  if (!githubLink) {
    githubLinkError.textContent = '请输入链接或镜像名';
    githubLinkError.classList.add('text-field__error--visible');
    return;
  }

  const result = generateOutput(githubLink, selectedFormat);

  if (result.error) {
    githubLinkError.textContent = result.error;
    githubLinkError.classList.add('text-field__error--visible');
    output.style.display = 'none';
  } else {
    formattedLinkOutput.textContent = result.link;
    output.style.display = 'flex';
    openButton.disabled = !result.isUrl;
  }
}

function updateSliderPosition() {
  const activeButton = formatToggle.querySelector('.active');
  if (activeButton) {
    const rect = activeButton.getBoundingClientRect();
    const containerRect = formatToggle.getBoundingClientRect();
    slider.style.width = rect.width + 'px';
    slider.style.transform = 'translateX(' + (rect.left - containerRect.left) + 'px)';
  }
}

function initSlider() {
  updateSliderPosition();
  const resizeObserver = new ResizeObserver(updateSliderPosition);
  resizeObserver.observe(formatToggle);
}

// 事件监听
githubForm.addEventListener('submit', function (e) {
  e.preventDefault();
  handleFormAction();
});

formatToggle.addEventListener('click', (e) => {
  const button = e.target.closest('button');
  if (!button || button.classList.contains('active')) return;
  formatToggle.querySelector('.active')?.classList.remove('active');
  button.classList.add('active');
  updateSliderPosition();
  if (githubLinkInput.value.trim()) {
    handleFormAction();
  }
});

githubLinkInput.addEventListener('input', () => {
  githubLinkError.textContent = '';
  githubLinkError.classList.remove('text-field__error--visible');
});

copyButton.addEventListener('click', function () {
  if (!formattedLinkOutput.textContent) return;
  navigator.clipboard.writeText(formattedLinkOutput.textContent).then(() => {
    showToast('已复制到剪贴板');
  }).catch(err => {
    console.error('复制失败: ', err);
    showToast('复制失败');
  });
});

openButton.addEventListener('click', function () {
  if (!openButton.disabled) {
    window.open(formattedLinkOutput.textContent, '_blank');
  }
});

// 标签页切换
function switchTab(btn, tabId) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('tab-' + tabId).classList.add('active');
}

// 复制代码块
function copyCode(btn) {
  const codeBody = btn.closest('.code-block').querySelector('.code-body');
  const text = codeBody.textContent;
  navigator.clipboard.writeText(text).then(() => {
    showToast('已复制到剪贴板');
  }).catch(err => {
    console.error('复制失败: ', err);
    showToast('复制失败');
  });
}

// 初始化
document.addEventListener('DOMContentLoaded', () => {
  initSlider();
  
  // 检查服务状态
  fetch('/health')
    .then(r => r.json())
    .then(() => {
      document.getElementById('githubStatus').textContent = '运行中';
      document.getElementById('dockerStatus').textContent = '运行中';
    })
    .catch(() => {
      document.getElementById('githubStatus').textContent = '异常';
      document.getElementById('dockerStatus').textContent = '异常';
    });
});
