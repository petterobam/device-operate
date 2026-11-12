import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const unpackedPath = (filePath) => (filePath.includes("app.asar") ? filePath.replace("app.asar", "app.asar.unpacked") : filePath);

export const FILE_TYPE_CATALOG = [
  { id: "mp4", label: "MP4 视频", extensions: ["mp4"], category: "视频" },
  { id: "mov", label: "QuickTime 视频", extensions: ["mov"], category: "视频" },
  { id: "mkv", label: "Matroska 视频", extensions: ["mkv"], category: "视频" },
  { id: "avi", label: "AVI 视频", extensions: ["avi"], category: "视频" },
  { id: "webm", label: "WebM 视频", extensions: ["webm"], category: "视频" },
  { id: "m4v", label: "M4V 视频", extensions: ["m4v"], category: "视频" },
  { id: "jpg", label: "JPEG 图像", extensions: ["jpg", "jpeg"], category: "图像" },
  { id: "png", label: "PNG 图像", extensions: ["png"], category: "图像" },
  { id: "heic", label: "HEIC 图像", extensions: ["heic"], category: "图像" },
  { id: "gif", label: "GIF 图像", extensions: ["gif"], category: "图像" },
  { id: "webp", label: "WebP 图像", extensions: ["webp"], category: "图像" },
  { id: "svg", label: "SVG 图像", extensions: ["svg"], category: "图像" },
  { id: "pdf", label: "PDF 文档", extensions: ["pdf"], category: "文档" },
  { id: "txt", label: "纯文本文档", extensions: ["txt"], category: "文档" },
  { id: "md", label: "Markdown 文档", extensions: ["md", "markdown"], category: "文档" },
  { id: "rtf", label: "富文本文档", extensions: ["rtf"], category: "文档" },
  { id: "csv", label: "CSV 表格", extensions: ["csv"], category: "文档" },
  { id: "docx", label: "Word 文档", extensions: ["docx"], category: "Office" },
  { id: "doc", label: "旧版 Word 文档", extensions: ["doc"], category: "Office" },
  { id: "xlsx", label: "Excel 工作簿", extensions: ["xlsx"], category: "Office" },
  { id: "xls", label: "旧版 Excel 工作簿", extensions: ["xls"], category: "Office" },
  { id: "pptx", label: "PowerPoint 演示文稿", extensions: ["pptx"], category: "Office" },
  { id: "ppt", label: "旧版 PowerPoint 演示文稿", extensions: ["ppt"], category: "Office" },
  { id: "mp3", label: "MP3 音频", extensions: ["mp3"], category: "音频" },
  { id: "m4a", label: "M4A 音频", extensions: ["m4a"], category: "音频" },
  { id: "wav", label: "WAV 音频", extensions: ["wav"], category: "音频" },
  { id: "flac", label: "FLAC 音频", extensions: ["flac"], category: "音频" },
  { id: "zip", label: "ZIP 压缩包", extensions: ["zip"], category: "压缩包" },
  { id: "rar", label: "RAR 压缩包", extensions: ["rar"], category: "压缩包" },
  { id: "7z", label: "7-Zip 压缩包", extensions: ["7z"], category: "压缩包" },
  { id: "tar", label: "TAR 归档", extensions: ["tar"], category: "压缩包" },
  { id: "gz", label: "Gzip 压缩包", extensions: ["gz"], category: "压缩包" },
  { id: "html", label: "HTML 网页", extensions: ["html", "htm"], category: "开发" },
  { id: "json", label: "JSON 数据", extensions: ["json"], category: "开发" },
  { id: "xml", label: "XML 数据", extensions: ["xml"], category: "开发" },
  { id: "js", label: "JavaScript 文件", extensions: ["js", "mjs"], category: "开发" },
  { id: "css", label: "CSS 样式表", extensions: ["css"], category: "开发" },
  { id: "py", label: "Python 脚本", extensions: ["py"], category: "开发" },
  { id: "epub", label: "EPUB 电子书", extensions: ["epub"], category: "电子书" }
].map((type, priority) => ({ ...type, priority }));

function appSummary(application) {
  if (!application) return null;
  return {
    id: application.id,
    name: application.name,
    bundleId: application.bundleId,
    path: application.path,
    iconUrl: application.iconUrl,
    system: application.system
  };
}

function parseHelperOutput(stdout) {
  try {
    const result = JSON.parse(stdout);
    if (!result.ok) throw new Error(result.error || "文件关联操作失败");
    return result;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("文件关联助手返回了无效结果");
    throw error;
  }
}

export function createFileAssociationService({
  applicationService,
  helperPath = unpackedPath(path.join(currentDir, "bin", "file-associations")),
  runHelper = async (args) => {
    const { stdout } = await execFileAsync(helperPath, args, { maxBuffer: 4 * 1024 * 1024 });
    return parseHelperOutput(stdout);
  }
} = {}) {
  if (!applicationService) throw new Error("applicationService is required");

  async function ensureHelper() {
    try {
      await fs.access(helperPath);
    } catch {
      throw Object.assign(new Error("文件关联助手尚未构建，请重新安装“我的macOS”"), { status: 503 });
    }
  }

  async function listFileAssociations({ fresh = false } = {}) {
    await ensureHelper();
    const [helperResult, installedApplications] = await Promise.all([
      runHelper(["get", ...FILE_TYPE_CATALOG.map((type) => type.extensions[0])]),
      applicationService.listInstalledApplications({ fresh })
    ]);
    const applications = installedApplications.filter(({ bundleId }) => bundleId);
    const byBundleId = new Map(applications.map((application) => [application.bundleId.toLowerCase(), application]));
    const helperTypes = new Map((helperResult.types || []).map((type) => [type.extension, type]));

    const types = FILE_TYPE_CATALOG.map((catalogType) => {
      const association = helperTypes.get(catalogType.extensions[0]) || {};
      const defaultBundleId = association.defaultHandler || "";
      const defaultApplication = byBundleId.get(defaultBundleId.toLowerCase()) || null;
      const compatibleApplications = [...new Set(association.handlers || [])]
        .map((bundleId) => byBundleId.get(String(bundleId).toLowerCase()))
        .filter(Boolean)
        .map(appSummary);
      return {
        ...catalogType,
        uti: association.uti || "",
        defaultBundleId,
        defaultApplication: appSummary(defaultApplication),
        handlerMissing: Boolean(defaultBundleId && !defaultApplication),
        compatibleApplications
      };
    });

    return {
      types,
      applications: applications.map(appSummary),
      summary: {
        total: types.length,
        assigned: types.filter(({ defaultBundleId }) => defaultBundleId).length,
        missing: types.filter(({ handlerMissing }) => handlerMissing).length,
        applicationCount: new Set(types.map(({ defaultBundleId }) => defaultBundleId).filter(Boolean)).size
      }
    };
  }

  async function setDefaultApplication(typeId, bundleId) {
    await ensureHelper();
    const fileType = FILE_TYPE_CATALOG.find(({ id }) => id === typeId);
    if (!fileType) throw Object.assign(new Error("不支持的文件类型"), { status: 404 });
    const applications = await applicationService.listInstalledApplications();
    const application = applications.find((item) => item.bundleId.toLowerCase() === String(bundleId).toLowerCase());
    if (!application) throw Object.assign(new Error("所选应用不存在"), { status: 404 });
    const helperResult = await runHelper(["get", fileType.extensions[0]]);
    const uti = helperResult.types?.[0]?.uti;
    if (!uti) throw Object.assign(new Error("macOS 无法识别该文件类型"), { status: 422 });
    await runHelper(["set", uti, application.bundleId]);
    return { typeId, uti, application: appSummary(application) };
  }

  return { listFileAssociations, setDefaultApplication };
}
