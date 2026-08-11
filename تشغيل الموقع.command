#!/bin/zsh

set -e
cd "${0:A:h}"

if [[ ! -d node_modules ]]; then
  echo "جاري تثبيت متطلبات الموقع..."
  npm install
fi

export MODE="${MODE:-demo}"
export PORT="${PORT:-3000}"

echo ""
echo "الموقع يعمل الآن على: http://localhost:${PORT}"
echo "لا تغلق هذه النافذة أثناء استخدام الموقع."
echo ""

open "http://localhost:${PORT}"
npm start
