#!/bin/bash

# Trace Skill Deployment Helper
# This script provides guidance on how to deploy this skill.

echo "🚀 Trace Skill Deployment Guide"
echo "--------------------------------"
echo ""

echo "Option 1: Railway (Simple & Fast)"
echo "1. Create a new project on Railway.app"
echo "2. Connect this GitHub repository"
echo "3. Add these variables in the 'Variables' tab:"
echo "   - TRACE_HMAC_SECRET (from the Trace Developer Dashboard)"
echo "   - PORT=8080"
echo "4. Railway will auto-build and provide a Public Domain."
echo ""

echo "Option 2: Vercel"
echo "1. Run 'npm install -g vercel'"
echo "2. Run 'vercel' in this directory"
echo "3. Ensure your project is configured as a Node.js runtime."
echo ""

echo "Option 3: Manual (Docker/PM2)"
echo "1. Run 'npm run build'"
echo "2. Run 'npm start' on your server"
echo "3. Ensure you have a valid HTTPS certificate (e.g., via Caddy/Nginx)."
echo ""

echo "⚠️  REMEMBER: After deploying, update your Skill endpoints in the Trace Dashboard!"
