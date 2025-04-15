# 빌드 단계
FROM node:20-alpine AS build

WORKDIR /app

# 의존성 설치
COPY package*.json ./
RUN npm ci

# 소스 복사 및 빌드
COPY . .
RUN npm run build
RUN npm run pkg

# 실행 단계
FROM node:20-slim

WORKDIR /app

# pkg로 빌드된 단일 실행 파일 복사
COPY --from=build /app/dist-pkg/lightweight /app/lightweight

# public 디렉토리 복사 (정적 파일 제공용)
COPY --from=build /app/public /app/public

# 실행 권한 추가
RUN chmod +x /app/lightweight

# 포트 노출 (3002로 변경)
EXPOSE 3002

# 실행
CMD ["/app/lightweight"] 
