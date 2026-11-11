# 🔮 연상퀴즈 (최대 5인 실시간)

## 폴더 구조
```
yeonsang-quiz/
├─ server.js          ← 게임 서버 (⚙️ 시간/점수 설정은 맨 위 CONFIG)
├─ quizzes.js         ← 📝 퀴즈(주제/정답/힌트) 작성하는 곳
├─ package.json
├─ render.yaml
└─ public/
   ├─ index.html
   ├─ style.css
   ├─ app.js
   └─ images/
      ├─ start.png    ← 시작화면 이미지 (직접 넣기)
      ├─ bg.png       ← 게임 배경 이미지 (직접 넣기)
      └─ char1~5.png  ← 캐릭터 뒷모습 이미지 (직접 넣기, 선택)
```

## 로컬 실행
```
npm install
npm start
# http://localhost:3000
```

## Render 배포
1. 이 폴더를 GitHub 저장소에 올립니다.
2. render.com → New → Web Service → 저장소 선택
3. Build Command: `npm install` / Start Command: `npm start`
4. (선택) Environment 에 `ADMIN_PASSWORD` 를 넣으면 비밀번호 변경 가능 (기본 admin09)
