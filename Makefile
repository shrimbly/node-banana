dev:
	npm run dev

sync-fork:
	@echo "Fetching from upstream..."
	git fetch upstream
	@echo "Merging upstream/main into current branch..."
	git merge upstream/main
	@echo "Pushing to origin..."
	git push origin
	@echo "Fork synced successfully!"

setup-upstream:
	@echo "Setting up upstream remote..."
	@read -p "Enter upstream repository URL: " url; \
	git remote add upstream $$url
	@echo "Upstream remote added. Run 'make sync-fork' to sync."