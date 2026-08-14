import JSZip from "jszip";
import {
  XML_DECLARATION,
  asList,
  asRecord,
  asText,
  tableRows,
  writeZip,
  xmlEscape,
  type JsonRecord,
} from "./create-common.js";

function pptxTextShape(
  id: number,
  name: string,
  text: string,
  box: { x: number; y: number; width: number; height: number },
  options: { size: number; bold?: boolean; align?: "ctr" | "l" } = { size: 1800 },
): string {
  const paragraphs = text.split("\n").map((line) => {
    const bullet = line.startsWith("• ");
    const content = bullet ? line.slice(2) : line;
    return `<a:p><a:pPr algn="${options.align ?? "l"}"${bullet ? ' marL="342900" indent="-285750"><a:buChar char="•"/></a:pPr>' : "/>"}<a:r><a:rPr lang="en-US" sz="${options.size}"${options.bold ? ' b="1"' : ""}/><a:t>${xmlEscape(content)}</a:t></a:r><a:endParaRPr lang="en-US" sz="${options.size}"/></a:p>`;
  });
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${xmlEscape(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${box.x}" y="${box.y}"/><a:ext cx="${box.width}" cy="${box.height}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr wrap="square"/><a:lstStyle/>${paragraphs.join("")}</p:txBody></p:sp>`;
}

function pptxTable(id: number, rows: string[][]): string {
  const columnCount = Math.max(...rows.map((row) => row.length), 1);
  const width = 10_972_800;
  const height = 4_191_000;
  const columnWidth = Math.floor(width / columnCount);
  // Keep every requested row inside the declared table frame. PowerPoint and
  // LibreOffice otherwise disagree on whether overflowing rows are visible.
  const rowHeight = Math.max(1, Math.floor(height / rows.length));
  const cellXml = (cell: string, header: boolean) =>
    `<a:tc><a:txBody><a:bodyPr lIns="45720" rIns="45720" tIns="0" bIns="0" anchor="ctr"/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="900"${header ? ' b="1"' : ""}><a:solidFill><a:srgbClr val="1F2937"/></a:solidFill></a:rPr><a:t>${xmlEscape(cell)}</a:t></a:r><a:endParaRPr lang="en-US" sz="900"><a:solidFill><a:srgbClr val="1F2937"/></a:solidFill></a:endParaRPr></a:p></a:txBody><a:tcPr marT="0" marB="0" marL="45720" marR="45720"/></a:tc>`;
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Table ${id}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="571500" y="1397000"/><a:ext cx="${width}" cy="${height}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1" bandRow="1"><a:tableStyleId>{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}</a:tableStyleId></a:tblPr><a:tblGrid>${Array.from({ length: columnCount }, () => `<a:gridCol w="${columnWidth}"/>`).join("")}</a:tblGrid>${rows.map((row, rowIndex) => `<a:tr h="${rowHeight}">${row.map((cell) => cellXml(cell, rowIndex === 0)).join("")}</a:tr>`).join("")}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}

function pptxSlideXml(spec: JsonRecord, titleSlide: boolean): string {
  const shapes: string[] = [];
  let nextId = 2;
  const title = asText(spec.title || spec.heading).trim() || (titleSlide ? "Untitled" : "Slide");
  shapes.push(
    pptxTextShape(
      nextId++,
      "Title",
      title,
      titleSlide
        ? { x: 731_520, y: 1_981_200, width: 10_759_440, height: 914_400 }
        : { x: 571_500, y: 274_320, width: 10_972_800, height: 685_800 },
      { size: titleSlide ? 2800 : 2400, bold: true, align: titleSlide ? "ctr" : "l" },
    ),
  );
  const subtitle = titleSlide ? asText(spec.subtitle).trim() : "";
  if (subtitle) {
    shapes.push(
      pptxTextShape(
        nextId++,
        "Subtitle",
        subtitle,
        { x: 914_400, y: 3_048_000, width: 10_363_200, height: 685_800 },
        { size: 1800, align: "ctr" },
      ),
    );
  }
  const paragraph = asText(spec.paragraph).trim();
  const bullets = asList(spec.bullets).map(asText).filter(Boolean);
  const body = [paragraph, ...bullets.map((bullet) => `• ${bullet}`)].filter(Boolean).join("\n");
  if (body) {
    shapes.push(
      pptxTextShape(
        nextId++,
        "Body",
        body,
        { x: 822_960, y: 1_371_600, width: 10_546_080, height: 4_648_200 },
        { size: 1800 },
      ),
    );
  }
  const rows = tableRows(spec.table);
  if (rows.length > 0) {
    shapes.push(pptxTable(nextId++, rows));
  }
  return `${XML_DECLARATION}<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapes.join("")}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

const PPTX_GROUP_SHAPE = `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>`;

export async function createPptx(specValue: unknown, outputPath: string): Promise<void> {
  const spec = asRecord(specValue);
  const slideSpecs: Array<{ spec: JsonRecord; titleSlide: boolean }> = [];
  const title = asText(spec.title).trim();
  const subtitle = asText(spec.subtitle).trim();
  if (title || subtitle) {
    slideSpecs.push({ spec, titleSlide: true });
  }
  const requestedSlides =
    asList(spec.slides).length > 0 ? asList(spec.slides) : asList(spec.sections);
  for (const value of requestedSlides) {
    slideSpecs.push({
      spec:
        value && typeof value === "object" && !Array.isArray(value)
          ? asRecord(value)
          : { title: value },
      titleSlide: false,
    });
  }
  if (slideSpecs.length === 0) {
    slideSpecs.push({ spec: { title: "Untitled" }, titleSlide: true });
  }

  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `${XML_DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>${slideSpecs.map((_, index) => `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("")}</Types>`,
  );
  zip.file(
    "_rels/.rels",
    `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`,
  );
  zip.file(
    "docProps/core.xml",
    `${XML_DECLARATION}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlEscape(title || "Untitled")}</dc:title><dc:creator>Jarvis</dc:creator><cp:lastModifiedBy>Jarvis</cp:lastModifiedBy></cp:coreProperties>`,
  );
  zip.file(
    "docProps/app.xml",
    `${XML_DECLARATION}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Jarvis</Application><PresentationFormat>Widescreen</PresentationFormat><Slides>${slideSpecs.length}</Slides></Properties>`,
  );
  zip.file(
    "ppt/presentation.xml",
    `${XML_DECLARATION}<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slideSpecs.map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`).join("")}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
  );
  zip.file(
    "ppt/_rels/presentation.xml.rels",
    `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>${slideSpecs.map((_, index) => `<Relationship Id="rId${index + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`).join("")}</Relationships>`,
  );
  zip.file(
    "ppt/slideMasters/slideMaster1.xml",
    `${XML_DECLARATION}<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld name="Jarvis"><p:spTree>${PPTX_GROUP_SHAPE}</p:spTree></p:cSld><p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`,
  );
  zip.file(
    "ppt/slideMasters/_rels/slideMaster1.xml.rels",
    `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>`,
  );
  zip.file(
    "ppt/slideLayouts/slideLayout1.xml",
    `${XML_DECLARATION}<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${PPTX_GROUP_SHAPE}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
  );
  zip.file(
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
    `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`,
  );
  zip.file(
    "ppt/theme/theme1.xml",
    `${XML_DECLARATION}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Jarvis"><a:themeElements><a:clrScheme name="Jarvis"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F2937"/></a:dk2><a:lt2><a:srgbClr val="F8FAFC"/></a:lt2><a:accent1><a:srgbClr val="2563EB"/></a:accent1><a:accent2><a:srgbClr val="0F766E"/></a:accent2><a:accent3><a:srgbClr val="D97706"/></a:accent3><a:accent4><a:srgbClr val="7C3AED"/></a:accent4><a:accent5><a:srgbClr val="DB2777"/></a:accent5><a:accent6><a:srgbClr val="475569"/></a:accent6><a:hlink><a:srgbClr val="0000FF"/></a:hlink><a:folHlink><a:srgbClr val="800080"/></a:folHlink></a:clrScheme><a:fontScheme name="Jarvis"><a:majorFont><a:latin typeface="Aptos Display"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Aptos"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Jarvis"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"/></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"/></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill><a:noFill/></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`,
  );
  for (const [index, slide] of slideSpecs.entries()) {
    zip.file(`ppt/slides/slide${index + 1}.xml`, pptxSlideXml(slide.spec, slide.titleSlide));
    zip.file(
      `ppt/slides/_rels/slide${index + 1}.xml.rels`,
      `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`,
    );
  }
  await writeZip(zip, outputPath);
}
