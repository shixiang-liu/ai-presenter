"""
PPT Parser Service
Uses Windows COM to export PPT slides as high-quality images
"""
import asyncio
import os
from pathlib import Path
from typing import List, Dict, Optional
import shutil

async def parse_ppt_to_images(ppt_path: str, output_dir: str) -> List[Dict]:
    """
    Convert PPT/PPTX to images using PowerPoint COM
    
    Args:
        ppt_path: Path to the PPT/PPTX file
        output_dir: Directory to save exported images
    
    Returns:
        List of slide info: [{"index": 1, "image_path": "...", "notes": "..."}]
    """
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)
    
    # Run COM operation in thread pool (blocking operation)
    result = await asyncio.to_thread(_export_slides_com, ppt_path, str(output_path))
    return result

def _export_slides_com(ppt_path: str, output_dir: str) -> List[Dict]:
    """
    Export slides using PowerPoint COM (runs in thread)
    """
    try:
        import win32com.client
        import pythoncom
        
        # Initialize COM in this thread
        pythoncom.CoInitialize()
        
        try:
            # Create PowerPoint application
            ppt_app = win32com.client.Dispatch("PowerPoint.Application")
            
            # 某些 PowerPoint 版本不允许隐藏窗口运行
            # 尝试设置为不可见，如果失败则设置为可见但最小化
            try:
                ppt_app.Visible = False
            except Exception:
                ppt_app.Visible = True
                try:
                    ppt_app.WindowState = 2  # ppWindowMinimized
                except Exception:
                    pass
            
            # Open presentation
            abs_path = os.path.abspath(ppt_path)
            presentation = ppt_app.Presentations.Open(abs_path, WithWindow=False)
            
            slides_info = []
            
            for i, slide in enumerate(presentation.Slides, 1):
                # Export slide as PNG
                image_filename = f"slide_{i:04d}.png"
                image_path = os.path.join(output_dir, image_filename)
                
                # Export at high resolution (1920x1080 equivalent)
                slide.Export(image_path, "PNG", 1920, 1080)
                
                # Get speaker notes if available
                notes = ""
                try:
                    notes_shape = slide.NotesPage.Shapes.Placeholders(2)
                    if notes_shape.HasTextFrame:
                        notes = notes_shape.TextFrame.TextRange.Text
                except:
                    pass
                
                slides_info.append({
                    "index": i,
                    "image_path": image_path,
                    "notes": notes
                })
            
            # Close presentation
            presentation.Close()
            ppt_app.Quit()
            
            return slides_info
            
        finally:
            pythoncom.CoUninitialize()
            
    except ImportError:
        # Fallback if win32com not available
        return _fallback_pdf_conversion(ppt_path, output_dir)
    except Exception as e:
        print(f"COM export failed: {e}")
        return _fallback_pdf_conversion(ppt_path, output_dir)

def _fallback_pdf_conversion(file_path: str, output_dir: str) -> List[Dict]:
    """
    Fallback: Try to use pdf2image if it's a PDF
    """
    try:
        if file_path.lower().endswith('.pdf'):
            from pdf2image import convert_from_path
            
            images = convert_from_path(file_path, dpi=150)
            slides_info = []
            
            for i, image in enumerate(images, 1):
                image_filename = f"slide_{i:04d}.png"
                image_path = os.path.join(output_dir, image_filename)
                image.save(image_path, "PNG")
                
                slides_info.append({
                    "index": i,
                    "image_path": image_path,
                    "notes": ""
                })
            
            return slides_info
    except Exception as e:
        print(f"PDF conversion failed: {e}")
    
    return []

async def get_slide_count(ppt_path: str) -> int:
    """Get the number of slides in a presentation
    
    尝试多种方法获取页数：
    1. 对于 PPTX: 使用 python-pptx
    2. 对于 PDF: 使用 pdf2image 或 PyPDF2
    3. 备用: 使用 PowerPoint COM (可能失败)
    """
    path = Path(ppt_path)
    suffix = path.suffix.lower()
    
    # 方法1: 对于 PPTX，使用 python-pptx（无需 COM）
    if suffix == '.pptx':
        try:
            from pptx import Presentation
            prs = Presentation(str(path))
            return len(prs.slides)
        except Exception as e:
            print(f"python-pptx failed: {e}")
    
    # 方法2: 对于 PDF，使用 PyPDF2 或 pdf2image
    if suffix == '.pdf':
        try:
            from PyPDF2 import PdfReader
            reader = PdfReader(str(path))
            return len(reader.pages)
        except Exception:
            pass
        
        try:
            from pdf2image import pdfinfo_from_path
            info = pdfinfo_from_path(str(path))
            return info.get("Pages", 0)
        except Exception as e:
            print(f"PDF page count failed: {e}")
    
    # 方法3: 备用 - 使用 PowerPoint COM (可能失败)
    try:
        import win32com.client
        
        def _count_slides():
            import pythoncom
            pythoncom.CoInitialize()
            try:
                ppt_app = win32com.client.Dispatch("PowerPoint.Application")
                # 尝试设置为可见（某些版本不允许隐藏）
                try:
                    ppt_app.Visible = False
                except Exception:
                    ppt_app.Visible = True
                    
                abs_path = os.path.abspath(ppt_path)
                presentation = ppt_app.Presentations.Open(abs_path, WithWindow=False)
                count = presentation.Slides.Count
                presentation.Close()
                ppt_app.Quit()
                return count
            finally:
                pythoncom.CoUninitialize()
        
        return await asyncio.to_thread(_count_slides)
    except Exception as e:
        print(f"COM slide count failed: {e}")
        return 0

