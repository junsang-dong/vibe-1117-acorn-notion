require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { Client } = require('@notionhq/client');
const { blocksToMarkdown, richTextToMarkdown } = require('./utils/notionToMarkdown');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// Vercel에서는 express.static()이 무시되므로 루트 경로를 명시적으로 처리
// 참고: https://vercel.com/docs/frameworks/backend/express#limitations
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Notion Client 초기화
const notion = new Client({
  auth: process.env.NOTION_TOKEN,
});

const databaseId = process.env.NOTION_DATABASE_ID;

/**
 * 데이터베이스 속성 값 추출
 */
function getPropertyValue(property) {
  const type = property.type;

  switch (type) {
    case 'title':
      return richTextToMarkdown(property.title);
    case 'rich_text':
      return richTextToMarkdown(property.rich_text);
    case 'multi_select':
      return property.multi_select.map(item => item.name);
    case 'select':
      return property.select?.name || null;
    case 'url':
      return property.url;
    case 'files':
      return property.files.map(file => 
        file.type === 'external' ? file.external.url : file.file.url
      );
    case 'date':
      return property.date;
    case 'checkbox':
      return property.checkbox;
    case 'number':
      return property.number;
    default:
      return null;
  }
}

/**
 * GET /api/posts
 * Notion 데이터베이스에서 게시글 목록 가져오기
 */
app.get('/api/posts', async (req, res) => {
  try {
    // 데이터베이스 쿼리 - 발행 준비된 게시글만 가져오기
    const response = await notion.databases.query({
      database_id: databaseId,
      filter: {
        property: 'Select',
        select: {
          equals: '발행 준비'
        }
      },
      sorts: [
        {
          property: '생성 일시',
          direction: 'descending'
        }
      ]
    });

    const posts = response.results.map(page => {
      const properties = page.properties;
      
      return {
        id: page.id,
        title: getPropertyValue(properties.Title || properties['Aa 이름'] || properties.제목 || properties.Name),
        tags: getPropertyValue(properties['다중 선택'] || properties.Tags || properties.태그),
        status: getPropertyValue(properties.Select || properties['텍스트'] || properties.Status || properties.상태),
        imageUrl: getPropertyValue(properties['파일과 미디어'] || properties.Image || properties.이미지)?.[0] || null,
        created: page.created_time,
        lastEdited: page.last_edited_time
      };
    });

    res.json({
      success: true,
      posts
    });

  } catch (error) {
    console.error('Error fetching posts:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/posts/:id
 * 특정 게시글의 상세 정보와 본문 가져오기
 */
app.get('/api/posts/:id', async (req, res) => {
  try {
    const pageId = req.params.id;

    // 페이지 정보 가져오기
    const page = await notion.pages.retrieve({ page_id: pageId });
    const properties = page.properties;

    // 페이지 블록(본문) 가져오기
    const blocks = await getPageBlocks(pageId);

    // Markdown으로 변환
    const markdown = blocksToMarkdown(blocks);

    const post = {
      id: page.id,
      title: getPropertyValue(properties['Aa 이름'] || properties.Title || properties.제목 || properties.Name),
      tags: getPropertyValue(properties['다중 선택'] || properties.Tags || properties.태그),
      status: getPropertyValue(properties['텍스트'] || properties.Status || properties.상태),
      imageUrl: getPropertyValue(properties['파일과 미디어'] || properties.Image || properties.이미지)?.[0] || null,
      content: markdown,
      created: page.created_time,
      lastEdited: page.last_edited_time
    };

    res.json({
      success: true,
      post
    });

  } catch (error) {
    console.error('Error fetching post:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * 페이지의 모든 블록 가져오기 (재귀적으로 자식 블록도 포함)
 */
async function getPageBlocks(pageId, accumulated = []) {
  const { results, has_more, next_cursor } = await notion.blocks.children.list({
    block_id: pageId,
    page_size: 100
  });

  accumulated.push(...results);

  // 자식 블록이 있는 경우 재귀적으로 가져오기
  for (const block of results) {
    if (block.has_children) {
      await getPageBlocks(block.id, accumulated);
    }
  }

  // 다음 페이지가 있는 경우
  if (has_more && next_cursor) {
    await getPageBlocks(pageId, accumulated);
  }

  return accumulated;
}

/**
 * POST /api/publish
 * 블로그에 게시글 발행하기
 */
app.post('/api/publish', async (req, res) => {
  try {
    const { postId } = req.body;

    if (!postId) {
      return res.status(400).json({
        success: false,
        error: 'Post ID is required'
      });
    }

    // 게시글 정보 가져오기
    const page = await notion.pages.retrieve({ page_id: postId });
    const properties = page.properties;
    const blocks = await getPageBlocks(postId);
    const markdown = blocksToMarkdown(blocks);

    const postData = {
      title: getPropertyValue(properties['Aa 이름'] || properties.Title || properties.제목 || properties.Name),
      content: markdown,
      tags: getPropertyValue(properties['다중 선택'] || properties.Tags || properties.태그),
      imageUrl: getPropertyValue(properties['파일과 미디어'] || properties.Image || properties.이미지)?.[0] || null,
      publishedAt: new Date().toISOString()
    };

    // 실제 블로그 API에 POST 요청 보내기 (옵션)
    // 여기서는 시뮬레이션만 수행
    if (process.env.BLOG_API_URL) {
      // const blogResponse = await fetch(process.env.BLOG_API_URL, {
      //   method: 'POST',
      //   headers: {
      //     'Content-Type': 'application/json',
      //     'Authorization': `Bearer ${process.env.BLOG_API_KEY}`
      //   },
      //   body: JSON.stringify(postData)
      // });
      // const blogResult = await blogResponse.json();
    }

    // Notion 페이지 상태를 "발행 완료"로 업데이트
    await notion.pages.update({
      page_id: postId,
      properties: {
        'Select': {
          select: {
            name: '발행 완료'
          }
        }
      }
    });

    res.json({
      success: true,
      message: '게시글이 성공적으로 발행되었습니다!',
      post: postData
    });

  } catch (error) {
    console.error('Error publishing post:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/database/properties
 * 데이터베이스 속성 정보 가져오기 (디버깅용)
 */
app.get('/api/database/properties', async (req, res) => {
  try {
    const database = await notion.databases.retrieve({
      database_id: databaseId
    });

    const properties = Object.entries(database.properties).map(([name, prop]) => ({
      name,
      type: prop.type,
      id: prop.id
    }));

    res.json({
      success: true,
      properties
    });

  } catch (error) {
    console.error('Error fetching database properties:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 로컬 개발 시 서버 시작 (Vercel에서는 app만 export)
if (typeof process.env.VERCEL === 'undefined') {
  app.listen(PORT, () => {
    console.log(`🚀 Server is running on http://localhost:${PORT}`);
    console.log(`📝 Notion Database ID: ${databaseId ? '설정됨' : '미설정'}`);
  });
}

// Vercel 서버리스 배포용 export
module.exports = app;

