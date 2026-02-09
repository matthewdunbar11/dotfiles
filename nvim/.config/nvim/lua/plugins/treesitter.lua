-- This config has been copied from LazyVim
return {
	-- Treesitter is a new parser generator tool that we can
	-- use in Neovim to power faster and more accurate
	-- syntax highlighting.
	{
		"nvim-treesitter/nvim-treesitter",
		version = false, -- last release is way too old and doesn't work on Windows
		lazy = false,
		-- dependencies = {
		-- 	{
		-- 		"nvim-treesitter/nvim-treesitter-textobjects",
		-- 		config = function()
		-- 			-- When in diff mode, we want to use the default
		-- 			-- vim text objects c & C instead of the treesitter ones.
		-- 			local move = require("nvim-treesitter.textobjects.move") ---@type table<string,fun(...)>
		-- 			local configs = require("nvim-treesitter.configs")
		-- 			for name, fn in pairs(move) do
		-- 				if name:find("goto") == 1 then
		-- 					move[name] = function(q, ...)
		-- 						if vim.wo.diff then
		-- 							local config = configs.get_module("textobjects.move")[name] ---@type table<string,string>
		-- 							for key, query in pairs(config or {}) do
		-- 								if q == query and key:find("[%]%[][cC]") then
		-- 									vim.cmd("normal! " .. key)
		-- 									return
		-- 								end
		-- 							end
		-- 						end
		-- 						return fn(q, ...)
		-- 					end
		-- 				end
		-- 			end
		-- 		end,
		-- 	},
		-- },
		build = ":TSUpdate",
		---@type TSConfig
		---@diagnostic disable-next-line: missing-fields
		opts = {
			highlight = { enable = true },
			indent = { enable = true },
			ensure_installed = {
				"bash",
				"brightscript",
				"css",
				"diff",
				"dockerfile",
				"gitignore",
				"go",
				"graphql",
				"hocon",
				"html",
				"javascript",
				"jsdoc",
				"json",
				"jsonc",
				"lua",
				"luadoc",
				"luap",
				"markdown",
				"markdown_inline",
				"python",
				"query",
				"rust",
				"regex",
				"scala",
				"terraform",
				"toml",
				"tsx",
				"typescript",
				"vim",
				"vimdoc",
				"yaml",
			},
			incremental_selection = {
				enable = true,
				keymaps = {
					init_selection = "<C-space>",
					node_incremental = "<C-space>",
					scope_incremental = false,
					node_decremental = "<bs>",
				},
			},
		},
		---@param opts TSConfig
		config = function(_, opts)
			if type(opts.ensure_installed) == "table" then
				---@type table<string, boolean>
				local added = {}
				opts.ensure_installed = vim.tbl_filter(function(lang)
					if added[lang] then
						return false
					end
					added[lang] = true
					return true
					---@diagnostic disable-next-line: param-type-mismatch
				end, opts.ensure_installed)
			end
			vim.treesitter.language.register("brightscript", "bs")
			vim.treesitter.language.register("brightscript", "brs")
		end,
	},

	-- Show context of the current function
	{
		"nvim-treesitter/nvim-treesitter-context",
		event = "VeryLazy",
		enabled = true,
		opts = { mode = "cursor", max_lines = 3 },
		keys = {
			{
				"<leader>ut",
				function()
					local tsc = require("treesitter-context")
					tsc.toggle()
				end,
				desc = "Toggle Treesitter Context",
			},
		},
	},

	-- Automatically add closing tags for HTML and JSX
	{
		"windwp/nvim-ts-autotag",
		event = "VeryLazy",
		opts = {},
	},
}
