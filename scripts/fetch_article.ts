import { Browser } from "../classes/Browser.ts";
import { writeFile, mkdir} from "fs/promises";

async function createFolder(path: string) {
  try {
    await mkdir(path, { recursive: true });
    console.log('Directory ready');
  } catch (err) {
    console.error('Error creating directory:', err);
  }
}

await createFolder("tmp");

{
  const data = await Browser.getArticle(); // "https://eraperemen.info/obzor-rynka-kriptovalyut-28-10-2026"
  await writeFile("./tmp/article.json", JSON.stringify(data, null, 2));
}

process.exit(0);
