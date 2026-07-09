import multer from "multer";

export const uploadJobDefinition = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 1,
    fileSize: 10 * 1024 * 1024
  }
}).single("artifact");
